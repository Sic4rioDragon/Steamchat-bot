// login.js — do the whole auth dance once, then glide using refresh tokens.

import fs from "fs";
import { LoginSession, EAuthTokenPlatformType } from "steam-session";
import SteamTotp from "steam-totp";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

export function setupLogin(ctx) {
  const { cfg, log, client } = ctx;

  // optional DPAPI; if missing, we store plaintext and recommend NTFS ACLs
  let dpapi = null;
  try { dpapi = require("win-dpapi"); } catch { /* optional */ }

  const jitter = (ms, pct=0.25) => { const d = Math.floor(ms * pct); return ms + Math.floor(Math.random()*(2*d+1)) - d; };

  function readRefresh() {
    try {
      if (!fs.existsSync(cfg._paths.REFRESH)) return "";
      const buf = fs.readFileSync(cfg._paths.REFRESH);
      if (dpapi && buf && buf[0] !== 0x7B && buf[0] !== 0x22) {
        try { return dpapi.unprotectData(buf, null, "CurrentUser").toString("utf8").trim(); } catch {}
      }
      return buf.toString("utf8").trim();
    } catch { return ""; }
  }
  function writeRefresh(t) {
    try {
      if (dpapi) {
        const enc = dpapi.protectData(Buffer.from(t,"utf8"), null, "CurrentUser");
        fs.writeFileSync(cfg._paths.REFRESH, enc); log.info("Refresh token saved (DPAPI).");
      } else {
        fs.writeFileSync(cfg._paths.REFRESH, t, "utf8");   log.info("Refresh token saved (plaintext).");
      }
    } catch(e){ log.warn("Failed to write refresh token: " + e.message); }
  }

  let relogBackoff = cfg.behavior?.relogin?.baseMs ?? 5000;
  let cooldownUntil = 0;
  let loggingIn = false;

  async function ensureRefreshViaQR() {
    if (readRefresh()) return;
    log.info("No refresh token yet. Starting QR login once...");
    const session = new LoginSession(EAuthTokenPlatformType.MobileApp);
    session.loginTimeout = 120000;

    const start = await session.startWithQR();
    const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(start.qrChallengeUrl);
    log.info("Scan this QR with the Steam mobile app and approve login:");
    console.log(qrUrl);

    await new Promise((resolve, reject) => {
      session.on("remoteInteraction", () => log.info("QR scanned. Approve on phone..."));
      session.on("authenticated", async () => {
        try {
          let token = "";
          if (typeof session.getAuthTokens === "function")      { token = (await session.getAuthTokens())?.refreshToken || ""; }
          else if (typeof session.getRefreshToken === "function"){ token = await session.getRefreshToken(); }
          else if (typeof session.getAccessTokens === "function"){ token = (await session.getAccessTokens())?.refreshToken || ""; }
          else { token = session.refreshToken || ""; }
          if (!token) throw new Error("No refresh token returned by session");
          writeRefresh(token); resolve();
        } catch (e) { reject(e); }
      });
      session.on("timeout", () => reject(new Error("QR login timed out.")));
      session.on("error", (e) => reject(e));
    });
  }

  function doLogOn(why="initial") {
    const now = Date.now();
    if (now < cooldownUntil) { const wait = cooldownUntil - now; log.info(`Cooldown active (${Math.ceil(wait/1000)}s). Skipping logon (${why}).`); setTimeout(() => doLogOn("cooldown"), wait + 1000); return; }
    if (loggingIn) { log.info("Already logging in; skipping duplicate doLogOn()"); return; }

    loggingIn = true;
    log.info(`Logging on (${why})...`);

    try {
      const rt = readRefresh();
      const opts = rt ? {
        refreshToken: rt, renewRefreshTokens: true, machineName: "sic4rio-steam-chat-bot"
      } : {
        accountName: cfg.account.username,
        password: cfg.account.password,
        rememberPassword: !!cfg.account.rememberPassword,
        twoFactorCode: cfg.account.twoFASharedSecret ? SteamTotp.generateAuthCode(cfg.account.twoFASharedSecret) : undefined,
        machineName: "sic4rio-steam-chat-bot"
      };
      client.logOn(opts);
    } catch(e) { loggingIn = false; log.warn("logOn threw: " + (e?.message || e)); }
  }

  (async () => { if (!readRefresh()) { try { await ensureRefreshViaQR(); } catch(e){ log.warn("QR login failed: " + (e?.message || e)); } } doLogOn(); })();

  client.on("refreshToken", (newToken) => { writeRefresh(newToken); log.info("Refresh token renewed by Steam; saved."); });
  client.on("loggedOn", () => { loggingIn = false; log.info(`Logged on as ${client.steamID?.getSteamID64()}`); relogBackoff = cfg.behavior?.relogin?.baseMs ?? 5000; client.setPersona(SteamUser.EPersonaState.Online); });

  client.on("steamGuard", (domain, cb) => {
    if (readRefresh()) { log.info("SteamGuard requested but refresh token exists; ignoring this prompt once."); cb(""); return; }
    const where = domain ? ` (email: ${domain})` : " (Steam mobile app)";
    log.warn(`Steam Guard required${where}. Paste the 5-digit code from your app/email and press Enter.`);
    process.stdout.write("> Code: ");
    process.stdin.once("data", d => {
      const code = d.toString().trim();
      if (!code) { log.warn("Code required (no refresh token yet)."); process.stdout.write("> Code: "); process.stdin.once("data", d2 => cb(d2.toString().trim())); return; }
      cb(code);
    });
  });

  client.on("webLogOnNeeded", () => { log.warn("Web logon needed; refreshing cookies..."); try { client.webLogOn(); } catch {} });

  client.on("error", (e) => {
    loggingIn = false;
    const msg = (e && (e.message || e.toString())) || "Unknown error";
    const isRate = /RateLimitExceeded/i.test(msg) || (e?.eresult === 84);
    if (isRate) { const waitMs = jitter(20*60*1000, 0.25); cooldownUntil = Date.now() + waitMs; log.warn(`Hit Steam rate limit; backing off for ~${Math.round(waitMs/60000)} min.`); setTimeout(() => { loggingIn = false; doLogOn("rate-limit-cooldown"); }, waitMs + 1500); return; }
    log.warn("Client error: " + msg);
    scheduleRelog("error");
  });
  client.on("disconnected", (eresult, msg) => { loggingIn = false; log.warn(`Disconnected (${eresult}): ${msg||""}`); scheduleRelog("disconnected"); });
  client.on("loggedOff", (eresult) => { loggingIn = false; log.warn(`Logged off (${eresult}).`); scheduleRelog("loggedOff"); });

  function scheduleRelog(reason) {
    if (!cfg.behavior?.relogin?.enabled) return;
    if (Date.now() < cooldownUntil) { const wait = cooldownUntil - Date.now(); log.info(`Cooldown active, relog in ~${Math.round(wait/1000)}s (${reason}).`); setTimeout(() => doLogOn("cooldown"), wait + 1000); return; }
    const cap = cfg.behavior?.relogin?.maxMs ?? 300000;
    const wait = Math.min(relogBackoff, cap);
    const w = (() => { const p=0.3; const d=Math.floor(wait*p); return wait + Math.floor(Math.random()*(2*d+1)) - d; })();
    log.info(`Reconnecting in ${Math.round(w/1000)}s (${reason})...`);
    setTimeout(() => doLogOn("reconnect"), w);
    relogBackoff = Math.min(relogBackoff * 2, cap);
  }

  ctx._loginInternals = { doLogOn };
}
