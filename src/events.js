// events.js — all steam-user event wiring in one place.

import SteamUser from "steam-user";
import { saveConfig } from "./config.js";

export function wireEvents(ctx) {
  const { cfg, log, client, community, state, allowlist, scanner, msg, webhook } = ctx;

  // After cookies, run poller, refresh names, prune, and greet sweep.
  client.on("webSession", async (_sid, cookies) => {
    community.setCookies(cookies);
    log.info("Web session established.");

    const pollEvery = Math.max(15000, Number(cfg.behavior?.pollFriendInvitesMs || 60000));
    setInterval(() => checkPendingInvitesAndAccept(), pollEvery);

    setInterval(() => allowlist.refreshNames(client), 6 * 60 * 60 * 1000);
    await allowlist.pruneAgainstFriends(client);
    setInterval(() => allowlist.pruneAgainstFriends(client), 60 * 60 * 1000);

    setTimeout(() => msg.greetUngreetedFriends(), 5000);
    setInterval(() => msg.greetUngreetedFriends(), 60 * 60 * 1000);
  });

  // Auto-fill ownerIDs if wanted and empty
  client.on("loggedOn", () => {
    if (cfg.admin?.autoAddSelfAsOwner && (!cfg.admin.ownerIDs || cfg.admin.ownerIDs.length === 0)) {
      const me = client.steamID?.getSteamID64();
      if (me) {
        cfg.admin.ownerIDs = [String(me)];
        saveConfig(cfg);
        log.info(`ownerIDs was empty — auto-filled with ${me} and saved to config.json`);
      }
    }
  });

  // Persona rename -> only update existing allowlist entries
  client.on("user", (sid, user) => {
    try {
      const id = sid.getSteamID64();
      if ((client.myFriends?.[id] !== SteamUser.EFriendRelationship.Friend)) return;
      if (!allowlist.isAllowlisted(id)) return;
      const persona = user?.player_name || "Unknown";
      if (allowlist.updateNameIfPresent(id, persona, true)) { allowlist.save(); log.info(`Name updated for ${id}: ${persona}`); }
    } catch {}
  });
  // Relationship changes (accept + welcome; remove on unfriend)
  client.on("relationship", async (sid, rel) => {
    try {
      const id = sid.getSteamID64();

      if (rel === SteamUser.EFriendRelationship.RequestRecipient && cfg.behavior?.autoAcceptFriends) {
        await client.addFriend(sid).catch(()=>{});
        log.info(`Accepted friend request from ${id}`);
        webhook.send({ type:"friend_accept", steamID:id });

        if (cfg.behavior?.sendWelcomeOnAccept) {
          msg.sendWelcomeSequence(id);
        }
      }

      if (rel === SteamUser.EFriendRelationship.None) {
        if (allowlist.remove(id)) { log.info(`Removed ${id} from allowlist (unfriended).`); }
      }
    } catch (e) { log.warn("relationship handler: " + e.message); }
  });

  // Friend message (commands, welcome-on-first-dm, language, money, scam)
  client.on("friendMessage", async (sid, message) => {
    const steamID = String(sid.getSteamID64());
    log.info(`DM from ${steamID}: ${message}`);

    // controller commands (owner/managers)
    const handledByCmds = await ctx.cmd.handleDirectMessage(steamID, message);
    if (handledByCmds) {
      // if it wasn't a command, we ignore controller's normal chat
      if (!message.startsWith("!")) return;
    }

    if (!state.greeted.has(steamID) && cfg.behavior?.sendWelcomeOncePerUser) {
      const ok = await msg.safeSend(steamID, cfg.messages.welcome);
      if (ok) { state.greeted.add(steamID); state.persist(); }
    }

    if (!scanner.isEnglishOrGerman(message)) { await msg.safeSend(steamID, cfg.messages.langPleaseEnglish); return; }

    // polite "no cash trades" ping (cooldown per user)
    await msg.maybeReplyNoCash(steamID, message);

    const scan = scanner.scanMessageForScam(message);
    if (scan.anyUrls && message.includes("/tradeoffer/")) {
      webhook.send({ type:"trade_offer_link", urls: scan.urls, message: message.slice(0,512) });
    }
    if (!scan.scam || allowlist.isAllowlisted(steamID)) return;

    const last = state.warnedAt.get(steamID) || 0;
    const now = Date.now();
    if (now - last > (cfg.behavior?.cooldowns?.minBetweenWarningsMs || 30000)) {
      state.warnedAt.set(steamID, now); state.persist();
      await msg.safeSend(steamID, cfg.messages.scamWarning);
    }

    await msg.safeSend(steamID, cfg.messages.scamFinal);
    await msg.removeAndMaybeBlock(steamID, !!cfg.behavior?.blockScamSender);
    ctx.log.csvFlag({ steamID, message, reason: scan.reason, urls: scan.urls });
    webhook.send({ type:"scam_removed", steamID, reason: scan.reason, urls: scan.urls });
  });

  // Fallback invite poller
  async function checkPendingInvitesAndAccept(){
    try {
      const entries = Object.entries(client.myFriends||{});
      const pending = entries.filter(([,rel]) => rel === SteamUser.EFriendRelationship.RequestRecipient).map(([id])=>id);
      if (!pending.length) return;
      for (const id of pending){
        await client.addFriend(id).catch(()=>{});
        log.info(`Accepted (poll) friend request from ${id}`);
        webhook.send({ type:"friend_accept", steamID:id });
        if (cfg.behavior?.sendWelcomeOnAccept) msg.sendWelcomeSequence(id);
      }
    } catch(e){ log.warn("invite poller failed: "+e.message); }
  }
}
