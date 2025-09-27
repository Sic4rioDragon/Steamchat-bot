// bot.js — v0.0.1 (Sic4rioDragon)
// Refresh-token (QR) login, manual-only allowlist, owner DM commands,
// persona-name refresh (no insert), prune removed friends, reliable welcome,
// sentry persisted, robust rate-limit backoff, invite poller, rate limiter.

import fs from "fs";
import path from "path";
import punycode from "punycode";
import SteamUser from "steam-user";
import SteamCommunity from "steamcommunity";
import SteamTotp from "steam-totp";
import { LoginSession, EAuthTokenPlatformType } from "steam-session";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const __dirname = path.resolve();
const cfgPath = path.join(__dirname, "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const RULES_PATH = path.join(__dirname, cfg.rules || "rules.json");
let rules = JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
let _dpapi = null;
try { _dpapi = require("win-dpapi"); } catch { /* optional */ }

const ALLOWLIST_PATH = path.join(__dirname, cfg.allowlistFile || "allowlist.json");
const DATA_DIR = path.join(__dirname, "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const LOG_DIR = path.join(__dirname, cfg.logging?.dir || "logs");
const SENTRY_PATH = path.join(__dirname, cfg.account?.sentryFile || "data/sentry.bin");
const LOGINKEY_PATH = path.join(__dirname, cfg.account?.loginKeyFile || "data/loginKey.txt"); // kept for compatibility
const REFRESH_PATH = path.join(__dirname, "data", "refreshToken.txt");
const NICKNAMES_PATH = path.join(__dirname, "nicknames.json"); // optional: { "7656...":"My Nick" }

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- state
let state = { greeted: [], warnedAt: {} };
try { if (fs.existsSync(STATE_PATH)) state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch {}
const greeted = new Set(state.greeted || []);
const warnedAt = new Map(Object.entries(state.warnedAt || {}).map(([k, v]) => [k, Number(v)]));

// ---------- allowlist normalize (entries[{steamID,name}])
function normalizeAllowlistObject(obj) {
  if (obj?.entries && Array.isArray(obj.entries)) return obj;
  if (obj?.steamIDs && Array.isArray(obj.steamIDs)) {
    return { entries: obj.steamIDs.map(id => ({ steamID: String(id), name: "Unknown" })) };
  }
  return { entries: [] };
}
let allowlistRaw = fs.existsSync(ALLOWLIST_PATH) ? JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8")) : { entries: [] };
let allowlist = normalizeAllowlistObject(allowlistRaw);

// ---------- nicknames (local override)
let nickMap = {};
try { if (fs.existsSync(NICKNAMES_PATH)) nickMap = JSON.parse(fs.readFileSync(NICKNAMES_PATH, "utf8")); } catch {}

// ---------- utils
function persistState() {
  try {
    const out = { greeted: Array.from(greeted), warnedAt: Object.fromEntries(warnedAt.entries()) };
    fs.writeFileSync(STATE_PATH, JSON.stringify(out, null, 2));
  } catch {}
}
function saveAllowlist() { try { fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2)); } catch {} }
setInterval(persistState, 5000);
process.on("exit", persistState);
process.on("SIGINT", () => { persistState(); process.exit(0); });

function nowStr(){ return new Date().toISOString(); }
function dailyLogPath(){
  const d = new Date();
  const f = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}.log`;
  return path.join(LOG_DIR, f);
}
function logLine(level, msg){ const line = `[${nowStr()}] [${level}] ${msg}\n`; fs.appendFileSync(dailyLogPath(), line); console.log(line.trim()); }
const logInfo=(m)=>logLine("INFO",m);
const logWarn=(m)=>logLine("WARN",m);
const logErr =(m)=>logLine("ERR",m);

function csvLogFlag({ steamID, message, reason, urls }){
  if (!cfg.logging?.logFlagsToCsv) return;
  const csv = path.join(LOG_DIR, "flags.csv");
  if (!fs.existsSync(csv)) fs.writeFileSync(csv, "time,steamID,reason,message,urls\n");
  const row = [ nowStr(), `"${steamID||""}"`, `"${(reason||"").replace(/"/g,'""')}"`, `"${(message||"").replace(/"/g,'""')}"`, `"${(urls||[]).join(" ")}"` ].join(",")+"\n";
  fs.appendFileSync(csv, row);
}

// rate limiter
let tokens = (cfg.rateLimiter?.burst ?? 4);
let lastRefill = Date.now();
function canSendNow() {
  const perMin = cfg.rateLimiter?.maxPerMinute ?? 12;
  const burst = cfg.rateLimiter?.burst ?? 4;
  const now = Date.now();
  const elapsed = (now - lastRefill) / 60000;
  const refill = elapsed * perMin;
  if (refill > 0) { tokens = Math.min(burst, tokens + refill); lastRefill = now; }
  if (tokens >= 1) { tokens -= 1; return true; }
  return false;
}

fs.watchFile(RULES_PATH, { interval: 1500 }, () => {
  try { rules = JSON.parse(fs.readFileSync(RULES_PATH, "utf8")); logInfo("Rules hot-reloaded."); }
  catch (e) { logWarn("Failed to reload rules: " + e.message); }
});
// ---------- Steam clients
const client = new SteamUser();
const community = new SteamCommunity();

// Owner IDs from config, fallback to your ID
const OWNER_IDS = Array.isArray(cfg.admin?.ownerIDs) && cfg.admin.ownerIDs.length
  ? cfg.admin.ownerIDs.map(String)
  : ["76561198282423950"];

// ---- Backoff helpers
let relogBackoff = cfg.behavior?.relogin?.baseMs ?? 5000;
let cooldownUntil = 0;
let loggingIn = false;
function jitter(ms, pct = 0.25) { const d = Math.floor(ms * pct); return ms + Math.floor(Math.random()*(2*d+1)) - d; }

// ---- Legacy loginKey (kept, but we’ll use refresh token flow)
function readLoginKey(){ try {
  if (fs.existsSync(LOGINKEY_PATH)) {
    const k = fs.readFileSync(LOGINKEY_PATH, "utf8").trim();
    if (k) logInfo("LoginKey loaded from disk."); else logInfo("LoginKey file exists but is empty.");
    return k;
  } else { logInfo("No loginKey file yet (Steam may never issue one)."); }
} catch (e) { logWarn("Failed to read loginKey: " + e.message); } return ""; }
function writeLoginKey(key){ try { fs.writeFileSync(LOGINKEY_PATH, key, "utf8"); logInfo("loginKey received & saved to disk."); } catch (e) { logWarn("Failed to write loginKey: " + e.message); } }

// ---- Refresh token helpers (recommended path)
function readRefreshToken(){
  try {
    if (!fs.existsSync(REFRESH_PATH)) return "";
    const buf = fs.readFileSync(REFRESH_PATH);
    if (_dpapi && buf && buf.length > 0 && buf[0] !== 0x7B && buf[0] !== 0x22) { // likely encrypted (not plain JSON/quotes)
      try {
        const dec = _dpapi.unprotectData(buf, null, "CurrentUser");
        return dec.toString("utf8").trim();
      } catch { /* fall through to plaintext */ }
    }
    return buf.toString("utf8").trim();
  } catch { return ""; }
}
function writeRefreshToken(t){
  try {
    if (_dpapi) {
      const enc = _dpapi.protectData(Buffer.from(t, "utf8"), null, "CurrentUser");
      fs.writeFileSync(REFRESH_PATH, enc);
      logInfo("Refresh token saved (DPAPI-encrypted).");
    } else {
      fs.writeFileSync(REFRESH_PATH, t, "utf8");
      logInfo("Refresh token saved (plaintext).");
    }
  } catch(e){ logWarn("Failed to write refresh token: " + e.message); }
}

// Sentry + loginKey events (sentry is still useful)
client.on("updateMachineAuth", (sentry, cb) => {
  try { fs.writeFileSync(SENTRY_PATH, sentry); logInfo(`Sentry saved (${sentry.length} bytes).`); }
  catch (e) { logWarn("Failed to write sentry: " + e.message); }
  cb({ sha_file: SteamUser.crypto.sha1(sentry) });
});
client.on("loginKey", (key) => { writeLoginKey(key); logInfo("loginKey received & saved."); });

// ---- One-time QR to obtain refresh token
async function ensureRefreshTokenViaQR(){
  let tok = readRefreshToken();
  if (tok) return tok;
  logInfo("No refresh token yet. Starting QR login once...");
  const session = new LoginSession(EAuthTokenPlatformType.MobileApp);
  session.loginTimeout = 120000; // 2 min

  const start = await session.startWithQR();
  const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(start.qrChallengeUrl);
  logInfo("Scan this QR with the Steam mobile app and approve login:");
  console.log(qrUrl);

  await new Promise((resolve, reject) => {
    session.on("remoteInteraction", () => logInfo("QR scanned. Approve on phone..."));
    session.on("authenticated", async () => {
  try {
    let refreshToken = "";

    if (typeof session.getAuthTokens === "function") {
      const tok = await session.getAuthTokens();            // { refreshToken, ... }
      refreshToken = tok?.refreshToken || "";
    } else if (typeof session.getRefreshToken === "function") {
      refreshToken = await session.getRefreshToken();       // string
    } else if (typeof session.getAccessTokens === "function") {
      const tok = await session.getAccessTokens();          // { refreshToken, ... }
      refreshToken = tok?.refreshToken || "";
    } else {
      refreshToken = session.refreshToken || "";
    }

    if (!refreshToken) throw new Error("No refresh token returned by session");
    writeRefreshToken(refreshToken);
    logInfo("Refresh token saved (via QR).");
    resolve();
  } catch (e) {
    reject(e);
  }
 });

    session.on("timeout", () => reject(new Error("QR login timed out.")));
    session.on("error", (e) => reject(e));
  });
  return readRefreshToken();
}

// ---- Login + reconnect
function doLogOn(why = "initial") {
  const now = Date.now();
  if (now < cooldownUntil) {
    const wait = cooldownUntil - now;
    logInfo(`Cooldown active (${Math.ceil(wait/1000)}s remaining). Skipping logon (${why}).`);
    setTimeout(() => doLogOn("cooldown"), wait + 1000);
    return;
  }
  if (loggingIn) { logInfo("Already logging in; skipping duplicate doLogOn()"); return; }

  loggingIn = true;
  logInfo(`Logging on (${why})...`);

  try {
    const rt = readRefreshToken();
    const opts = rt
      ? {
          // REFRESH TOKEN PATH (no username/password here)
          refreshToken: rt,
          renewRefreshTokens: true,
          machineName: "sic4rio-steam-chat-bot",
        }
      : {
          // FALLBACK PASSWORD PATH (first-time only)
          accountName: cfg.account.username,
          password: cfg.account.password,
          rememberPassword: !!cfg.account.rememberPassword,
          twoFactorCode: cfg.account.twoFASharedSecret
            ? SteamTotp.generateAuthCode(cfg.account.twoFASharedSecret)
            : undefined,
          machineName: "sic4rio-steam-chat-bot",
        };

    client.logOn(opts);
  } catch (e) {
    loggingIn = false;
    logWarn("logOn threw: " + (e?.message || e));
  }
}

// initial bootstrap: make sure we have a refresh token, then log on
(async () => { if (!readRefreshToken()) { try { await ensureRefreshTokenViaQR(); } catch(e){ logWarn("QR login failed: " + (e?.message || e)); } } doLogOn(); })();

client.on("refreshToken", (newToken) => { writeRefreshToken(newToken); logInfo("Refresh token renewed by Steam; saved."); });

client.on("loggedOn", () => {
  loggingIn = false;
  logInfo(`Logged on as ${client.steamID?.getSteamID64()}`);
  relogBackoff = cfg.behavior?.relogin?.baseMs ?? 5000;
  client.setPersona(SteamUser.EPersonaState.Online);
});

client.on("steamGuard", (domain, cb) => {
  const where = domain ? ` (email: ${domain})` : " (Steam mobile app)";
  logWarn(`Steam Guard required${where}. Paste the 5-digit code from your app/email and press Enter.`);
  process.stdout.write("> Code: ");
  process.stdin.once("data", d => {
    const code = d.toString().trim();
    if (!code) {
      logWarn("This library needs a code if no refresh token yet. Please paste the code.");
      process.stdout.write("> Code: ");
      process.stdin.once("data", d2 => cb(d2.toString().trim()));
      return;
    }
    cb(code);
  });
});

client.on("webSession", async (_sid, cookies) => {
  community.setCookies(cookies);
  logInfo("Web session established.");
  const interval = Math.max(15000, Number(cfg.behavior?.pollFriendInvitesMs || 60000));
  setInterval(checkPendingInvitesAndAccept, interval);
  setInterval(refreshAllowlistNames, 6 * 60 * 60 * 1000);
  await pruneAllowlistAgainstCurrentFriends();
  setInterval(pruneAllowlistAgainstCurrentFriends, 60 * 60 * 1000);
  setTimeout(greetUngreetedFriends, 5000);
  setInterval(greetUngreetedFriends, 60 * 60 * 1000);
});

client.on("webLogOnNeeded", () => { logWarn("Web logon needed; refreshing cookies..."); try { client.webLogOn(); } catch {} });

client.on("error", (e) => {
  loggingIn = false;
  const msg = (e && (e.message || e.toString())) || "Unknown error";
  const eres = e?.eresult ?? e?.eresult_code ?? null;
  const isRate = /RateLimitExceeded/i.test(msg) || eres === SteamUser.EResult?.RateLimitExceeded || eres === 84;
  if (isRate) {
    const waitMs = jitter(20*60*1000, 0.25); // ~15–25min
    cooldownUntil = Date.now() + waitMs;
    logWarn(`Hit Steam rate limit; backing off for ~${Math.round(waitMs/60000)} min.`);
    setTimeout(() => { loggingIn = false; doLogOn("rate-limit-cooldown"); }, waitMs + 1500);
    return;
  }
  logWarn("Client error: " + msg);
  scheduleRelog("error");
});
client.on("disconnected", (eresult, msg) => { loggingIn = false; logWarn(`Disconnected (${eresult}): ${msg||""}`); scheduleRelog("disconnected"); });
client.on("loggedOff", (eresult) => { loggingIn = false; logWarn(`Logged off (${eresult}).`); scheduleRelog("loggedOff"); });

function scheduleRelog(reason) {
  if (!cfg.behavior?.relogin?.enabled) return;
  if (Date.now() < cooldownUntil) {
    const wait = cooldownUntil - Date.now();
    logInfo(`Cooldown already active, relog in ~${Math.round(wait/1000)}s (${reason}).`);
    setTimeout(() => doLogOn("cooldown"), wait + 1000);
    return;
  }
  const cap = cfg.behavior?.relogin?.maxMs ?? 300000;
  const wait = Math.min(relogBackoff, cap);
  const w = jitter(wait, 0.3);
  logInfo(`Reconnecting in ${Math.round(w/1000)}s (${reason})...`);
  setTimeout(() => doLogOn("reconnect"), w);
  relogBackoff = Math.min(relogBackoff * 2, cap);
}
// persona rename -> refresh allowlist display name (never inserts)
client.on("user", (sid, user) => {
  try {
    const id = sid.getSteamID64();
    if (!isFriend(id)) return;
    if (!isAllowlisted(id)) return; // manual-only allowlist respected
    const newPersona = user?.player_name || "Unknown";
    const display = chooseDisplayName(id, newPersona);
    if (updateAllowlistNameIfPresent(id, display, /*silent*/true)) { saveAllowlist(); logInfo(`Name updated for ${id}: ${display}`); }
  } catch {}
});

// relationship changes
client.on("relationship", async (sid, rel) => {
  try {
    const id = sid.getSteamID64();
    if (rel === SteamUser.EFriendRelationship.RequestRecipient && cfg.behavior?.autoAcceptFriends) {
      await client.addFriend(sid).catch(()=>{});
      logInfo(`Accepted friend request from ${id}`);
      webhook({ type:"friend_accept", steamID:id });
      if (cfg.behavior?.sendWelcomeOnAccept) {
  // run the whole welcome attempt sequence (handles delay + retries internally)
  sendWelcomeSequence(id);
 }

    }
    if (rel === SteamUser.EFriendRelationship.None) {
      if (removeFromAllowlist(id)) { logInfo(`Removed ${id} from allowlist (unfriended).`); saveAllowlist(); }
    }
  } catch(e){ logWarn("relationship handler: "+e.message); }
});

// messages (owner commands first)
client.on("friendMessage", async (sid, message) => {
  const steamID = String(sid.getSteamID64());
  logInfo(`DM from ${steamID}: ${message}`);

  // OWNER COMMANDS
  // OWNER COMMANDS (ignore non-commands)
if (OWNER_IDS.includes(steamID)) {
  if (!message.startsWith("!allowlist")) {
    logInfo("Owner message ignored (not a command).");
    return;
  }
  const parts = message.trim().split(/\s+/);
  const cmd = parts[1]?.toLowerCase();
  if (cmd === "add") {
    const id = parts[2];
    const name = parts.slice(3).join(" ") || "Manual";
    if (!id) { await safeSend(steamID, "Usage: !allowlist add <steamID64> <name...>"); return; }
    upsertAllowlist(id, name); await safeSend(steamID, `Allowlisted: ${id} (${name}).`);
    return;
  }
  if (cmd === "remove") {
    const id = parts[2];
    if (!id) { await safeSend(steamID, "Usage: !allowlist remove <steamID64>"); return; }
    if (removeFromAllowlist(id)) { saveAllowlist(); await safeSend(steamID, `Removed from allowlist: ${id}.`); }
    else await safeSend(steamID, `ID not found: ${id}.`);
    return;
  }
  if (cmd === "list") {
    const count = allowlist.entries.length;
    const sample = allowlist.entries.slice(0, 10).map(e => `${e.steamID} ${e.name}`).join("\n") || "(empty)";
    await safeSend(steamID, `Allowlist count: ${count}\n${sample}`);
    return;
  }
  await safeSend(steamID, "Commands: !allowlist add|remove|list");
  return;
}

  // Regular flow
  if (!greeted.has(steamID) && cfg.behavior?.sendWelcomeOncePerUser) {
  const ok = await safeSend(steamID, cfg.messages.welcome);
  if (ok) { greeted.add(steamID); persistState(); }
 }


  if (!isEnglishOrGerman(message)) { await safeSend(steamID, cfg.messages.langPleaseEnglish); return; }

  const scan = scanMessageForScam(message);
  if (!scan.scam || isAllowlisted(steamID)) return;

  const last = warnedAt.get(steamID) || 0;
  const now = Date.now();
  if (now - last > (cfg.behavior?.cooldowns?.minBetweenWarningsMs || 30000)) {
    warnedAt.set(steamID, now); persistState();
    await safeSend(steamID, cfg.messages.scamWarning);
  }

  await safeSend(steamID, cfg.messages.scamFinal);
  await removeAndMaybeBlock(steamID, !!cfg.behavior?.blockScamSender);
  csvLogFlag({ steamID, message, reason: scan.reason, urls: scan.urls });
  webhook({ type:"scam_removed", steamID, reason: scan.reason, urls: scan.urls });
});

// invite poller (fallback)
async function checkPendingInvitesAndAccept(){
  try {
    const entries = Object.entries(client.myFriends||{});
    const pending = entries.filter(([,rel]) => rel === SteamUser.EFriendRelationship.RequestRecipient).map(([id])=>id);
    if (!pending.length) return;
    for (const id of pending){
      await client.addFriend(id).catch(()=>{});
      logInfo(`Accepted (poll) friend request from ${id}`);
      webhook({ type:"friend_accept", steamID:id });
      if (cfg.behavior?.sendWelcomeOnAccept) {
  sendWelcomeSequence(id);
 }

    }
  } catch(e){ logWarn("invite poller failed: "+e.message); }
}
// personas helper + periodic refresh
function getPersonasMap(ids){
  return new Promise((resolve) => {
    if (!ids || ids.length === 0) return resolve({});
    client.getPersonas(ids, (err, personas) => resolve(personas || {}));
  });
}
async function refreshAllowlistNames(){
  try {
    const ids = allowlist.entries.map(e=>e.steamID);
    if (!ids.length) return;
    const map = await getPersonasMap(ids);
    let changed = 0;
    for (const id of ids){
      const persona = map[id]?.player_name || "Unknown";
      const display = chooseDisplayName(id, persona);
      if (updateAllowlistNameIfPresent(id, display, /*silent*/true)) changed++;
    }
    if (changed) { saveAllowlist(); logInfo(`Refreshed names for ${changed} friends.`); }
  } catch(e){ logWarn("Name refresh failed: "+e.message); }
}
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function sendWelcomeSequence(id){
  const delays = [2000, 10000, 30000]; // 2s, 10s, 30s
  for (let i = 0; i < delays.length; i++){
    if (i === 0) { await wait(delays[i]); logInfo(`Sending welcome to ${id}...`); }
    else { await wait(delays[i]); logInfo(`Welcome retry #${i} to ${id}...`); }
    const ok = await safeSend(id, cfg.messages.welcome);
    if (ok){
      greeted.add(String(id)); persistState();
      logInfo(`Welcome delivered to ${id}.`);
      return true;
    }
  }
  logWarn(`Failed to deliver welcome to ${id} after 3 attempts.`);
  return false;
}
async function greetUngreetedFriends(){
  try {
    const entries = Object.entries(client.myFriends || {})
      .filter(([, rel]) => rel === SteamUser.EFriendRelationship.Friend)
      .map(([id]) => String(id));

    for (const id of entries) {
      if (!greeted.has(id) && !isAllowlisted(id)) {
        logInfo(`Startup sweep: greeting ungreeted friend ${id}`);
        await sendWelcomeSequence(id);
      }
    }
  } catch (e) {
    logWarn("greetUngreetedFriends failed: " + e.message);
  }
}

async function pruneAllowlistAgainstCurrentFriends(){
  try {
    const friendIds = new Set(
      Object.entries(client.myFriends || {})
        .filter(([, rel]) => rel === SteamUser.EFriendRelationship.Friend)
        .map(([id]) => String(id))
    );
    const before = allowlist.entries.length;
    allowlist.entries = allowlist.entries.filter(e => friendIds.has(String(e.steamID)));
    const removed = before - allowlist.entries.length;
    if (removed > 0) { saveAllowlist(); logInfo(`Pruned ${removed} entries from allowlist (no longer friends).`); }
  } catch (e) { logWarn("Allowlist prune failed: " + e.message); }
}

// allowlist helpers
function isFriend(id){ try{ return client.myFriends?.[String(id)] === SteamUser.EFriendRelationship.Friend; } catch { return false; } }
function isAllowlisted(id){ return allowlist.entries.some(e => e.steamID === String(id)); }
function upsertAllowlist(id, name, silent=false){
  const s = String(id);
  const idx = allowlist.entries.findIndex(e => e.steamID === s);
  if (idx >= 0) {
    if (allowlist.entries[idx].name !== name) { allowlist.entries[idx].name = name; if (!silent) saveAllowlist(); return true; }
    return false;
  } else { allowlist.entries.push({ steamID: s, name }); if (!silent) saveAllowlist(); return true; }
}
function removeFromAllowlist(id){
  const s = String(id);
  const before = allowlist.entries.length;
  allowlist.entries = allowlist.entries.filter(e => e.steamID !== s);
  return allowlist.entries.length !== before;
}
// Only updates name if already present; never adds.
function updateAllowlistNameIfPresent(id, name, silent=false){
  const s = String(id);
  const idx = allowlist.entries.findIndex(e => e.steamID === s);
  if (idx === -1) return false;
  if (allowlist.entries[idx].name !== name) {
    allowlist.entries[idx].name = name;
    if (!silent) saveAllowlist();
    return true;
  }
  return false;
}

function chooseDisplayName(id, personaName){
  const s = String(id);
  if (nickMap[s]) return nickMap[s];
  try {
    if (typeof client.getNickname === "function") {
      const nick = client.getNickname(s);
      if (nick && String(nick).trim()) return String(nick);
    }
  } catch {}
  return personaName || "Unknown";
}

// chat + scanning
async function safeSend(target, text){
  if (!canSendNow()){
    logWarn("Rate limiter blocked a send; will try later in next sequence step if any.");
    return false;
  }
  try{
    const id = typeof target === "string" ? target
      : (target && typeof target.getSteamID64 === "function" ? target.getSteamID64() : String(target));
    await client.chat.sendFriendMessage(id, text);
    return true;
  }catch(e){
    logWarn("sendFriendMessage failed: " + (e?.message || e));
    return false;
  }
}

async function removeAndMaybeBlock(steamID64, alsoBlock){
  await new Promise(res => community.removeFriend(steamID64, () => res()));
  logInfo(`Removed ${steamID64} from friends.`);
  if (alsoBlock) { await new Promise(res => community.blockUser(steamID64, () => res())); logInfo(`Blocked ${steamID64}.`); }
}
const URL_RE = /\b((?:https?:\/\/)?[a-z0-9\-._~%]+(?:\.[a-z0-9\-._~%]+)+(?:\/[^\s]*)?)\b/ig;
function scanMessageForScam(message){
  const urls=[]; let m; while((m=URL_RE.exec(message))!==null) urls.push(normalizeUrl(m[1]));
  const badUrls=[]; for(const u of urls){
    const host=hostname(u); const xn=toASCII(host); const tld=host.split(".").pop()?.toLowerCase();
    const allowed=(rules.allowedDomains||[]).some(d=>host.endsWith(d));
    const denied=(rules.denyTLDs||[]).includes(tld);
    const hint=(rules.urlHints||[]).some(h=>u.toLowerCase().includes(h));
    if(!allowed && (hint||denied||looksPhishy(host,xn))) badUrls.push(u);
  }
  const low=message.toLowerCase();
  const kw=(rules.blockedKeywords||[]).some(k=>low.includes(k));
  const tooMany=urls.length>(rules.maxLinksPerMessage||3);
  const scam = badUrls.length>0 || kw || tooMany;
  const reason=scam?`badUrls:${badUrls.length} kw:${kw} links:${urls.length}`:"";
  if (urls.some(u=>u.includes("/tradeoffer/"))) webhook({ type:"trade_offer_link", urls, message: low.slice(0,512) });
  return { scam, reason, urls: badUrls.length?badUrls:urls };
}
function hostname(u){ try{ const url=new URL(u.startsWith("http")?u:"https://"+u); return url.hostname.toLowerCase(); }catch{ return ""; } }
function normalizeUrl(u){ return /^https?:\/\//i.test(u) ? u : "https://"+u; }
function toASCII(h){ try{ return punycode.toASCII(h); }catch{ return h; } }
function looksPhishy(host,xn){ if(!host||!xn) return false; const bases=["steam","steampowered","steamcommunity","discord","cs.money","csmoney"]; return bases.some(b=>typosLike(host,b)||typosLike(xn,b)); }
function typosLike(h,b){ const H=h.replace(/[0-9oO]/g,"o").replace(/[lI1]/g,"l"); const B=b.replace(/[0-9oO]/g,"o").replace(/[lI1]/g,"l"); return H.includes(B) && H!==B && H.length<=B.length+6; }
function isEnglishOrGerman(t){ t=t.toLowerCase(); const de=["und","ich","nicht","bitte","danke","hallo","warum","weil","ja","nein","tausche","handel","angebot"]; const en=["and"," i ","not","please","thanks","hello","why","because","yes","no","trade","offer"]; const hasDE=de.some(w=>t.includes(w)); const hasEN=en.some(w=>t.includes(w)); const letters=(t.match(/[a-z]/g)||[]).length; if(!hasDE&&!hasEN&&letters>=6) return false; return true; }

// webhook (Discord embeds)
async function webhook(payload){
  try{
    if (!cfg.webhook?.enabled || !cfg.webhook?.url) return;
    const important = ["scam_removed","trade_offer_link","allowlist_bootstrap","friend_accept"];
    if (cfg.webhook.onlyOnImportant && !important.includes(payload.type)) return;
    if (cfg.webhook.discordEmbeds){
      const embed = makeEmbed(payload);
      await fetch(cfg.webhook.url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ username:"Steam Bot", embeds:[embed] }) });
    } else {
      await fetch(cfg.webhook.url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ ts: nowStr(), ...payload }) });
    }
  }catch(e){ logWarn("Webhook failed: "+e.message); }
}
function makeEmbed(p){
  const titleMap={friend_accept:"New Friend Accepted",trade_offer_link:"Trade Offer Link Detected",scam_removed:"User Removed for Scam Pattern",allowlist_bootstrap:"Allowlist Bootstrapped"};
  const colorMap={friend_accept:0x2ecc71,trade_offer_link:0x3498db,scam_removed:0xe74c3c,allowlist_bootstrap:0xf1c40f};
  const e={ title:titleMap[p.type]||"Event", color:colorMap[p.type]||0x95a5a6, timestamp:nowStr(), fields:[] };
  if (p.steamID) e.fields.push({ name:"SteamID64", value:String(p.steamID), inline:true });
  if (p.reason)   e.fields.push({ name:"Reason", value:String(p.reason).slice(0,1024), inline:false });
  if (p.urls?.length) e.fields.push({ name:"URLs", value:p.urls.slice(0,5).join("\n").slice(0,1024), inline:false });
  if (p.count!==undefined) e.fields.push({ name:"Count", value:String(p.count), inline:true });
  return e;
}
