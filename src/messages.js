// messages.js — all chat-sending lives here so we can rate-limit and retry in one place.

function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

export function createMessenger(cfg, log, rate, client, community, state) {
  async function safeSend(target, text){
    if (!rate.canSendNow()) { log.warn("Rate limiter blocked a send; next attempt will handle retry if any."); return false; }
    try{
      const id = typeof target === "string" ? target
        : (target && typeof target.getSteamID64 === "function" ? target.getSteamID64() : String(target));
      await client.chat.sendFriendMessage(id, text);
      return true;
    }catch(e){ log.warn("sendFriendMessage failed: " + (e?.message || e)); return false; }
  }

  async function sendWelcomeSequence(id){
    const delays = [Math.max(2000, cfg.behavior?.cooldowns?.welcomeMs || 1000), 10000, 30000];
    for (let i = 0; i < delays.length; i++){
      await wait(delays[i]);
      log.info(i ? `Welcome retry #${i} to ${id}...` : `Sending welcome to ${id}...`);
      const ok = await safeSend(id, cfg.messages.welcome);
      if (ok){
        state.greeted.add(String(id)); state.persist();
        log.info(`Welcome delivered to ${id}.`);
        return true;
      }
    }
    log.warn(`Failed to deliver welcome to ${id} after 3 attempts.`);
    return false;
  }

  async function greetUngreetedFriends(){
    try {
      const entries = Object.entries(client.myFriends || {})
        .filter(([, rel]) => rel === client.constructor.EFriendRelationship.Friend)
        .map(([id]) => String(id));

      for (const id of entries) {
        if (!state.greeted.has(id) && !cfg._allowlist.isAllowlisted(id)) {
          log.info(`Startup sweep: greeting ungreeted friend ${id}`);
          await sendWelcomeSequence(id);
        }
      }
    } catch (e) { log.warn("greetUngreetedFriends failed: " + e.message); }
  }

  async function removeAndMaybeBlock(steamID64, alsoBlock){
    await new Promise(res => community.removeFriend(steamID64, () => res()));
    log.info(`Removed ${steamID64} from friends.`);
    if (alsoBlock) { await new Promise(res => community.blockUser(steamID64, () => res())); log.info(`Blocked ${steamID64}.`); }
  }

  // money trade quick reply (once per 12h per user)
  const MONEY_REPLY_COOLDOWN_MS = 12 * 60 * 60 * 1000;
  async function maybeReplyNoCash(steamID, message){
    if (!cfg._scanner.mentionsMoney(message)) return false;
    const last = state.moneyReplyAt.get(steamID) || 0;
    if (Date.now() - last < MONEY_REPLY_COOLDOWN_MS) return false;
    const ok = await safeSend(steamID, cfg.messages.noCashTrades);
    if (ok) { state.moneyReplyAt.set(steamID, Date.now()); state.persist(); }
    return ok;
  }

  return { safeSend, sendWelcomeSequence, greetUngreetedFriends, removeAndMaybeBlock, maybeReplyNoCash };
}
