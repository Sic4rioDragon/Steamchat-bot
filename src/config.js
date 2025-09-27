// config.js — collect all knobs here so we don't touch code to tune behavior.

import fs from "fs";
import path from "path";
const ROOT = path.resolve(path.join(import.meta.dirname, ".."));

const defaultCfg = {
  allowlistFile: "allowlist.json",
  rules: "rules.json",
  logging: { dir: "logs", logFlagsToCsv: true },

  account: {
    username: "", password: "",
    rememberPassword: true,
    twoFASharedSecret: "",            // optional backup for first login
    sentryFile: "data/sentry.bin",
    loginKeyFile: "data/loginKey.txt" // legacy, kept around
  },

  admin: {
    // If empty, we'll auto-fill it with the logged-in account's SteamID64 on first login.
    ownerIDs: [],
    // People who can manage the bot (commands) even if they're not the bot account.
    managerIDs: [],
    // Console commands (stdin) on/off
    consoleCommands: true,
    // Whether to auto-add the bot's own SteamID as owner if none specified.
    autoAddSelfAsOwner: true
  },

  behavior: {
    autoAcceptFriends: true,
    sendWelcomeOnAccept: true,
    sendWelcomeOncePerUser: true,

    // accept invites poller
    pollFriendInvitesMs: 60000,

    // relog backoff
    relogin: { enabled: true, baseMs: 5000, maxMs: 300000 },

    // timings
    cooldowns: { welcomeMs: 1000, minBetweenWarningsMs: 30000 }
  },

  rateLimiter: { maxPerMinute: 12, burst: 4 },

  // scanner-specific knobs
  scanner: {
    // extend/override these as you like
    moneyKeywords: ["cash","money","paypal","skrill","revolut","crypto","btc","eth","usdt","sell for","buy for","real money","irl money"]
  },

  messages: {
    welcome:
`Hi! I'm an automatic assistant/Bot made by Sic4rioDragon https://github.com/Sic4rioDragon/Steamchat-bot.
• Please say briefly why you added me.
• Trades: send a Steam trade offer (no cash trades). If I'm actively trading CS2/TF2 items and it's fair, I'll accept.
• "Gift" trades (you send items without agreed return) are treated as gifts and **not refundable**.
• If we know each other, say from where. Thanks!`,
    langPleaseEnglish: "English not detected — please write in English, thanks!",
    scamWarning: "You sent a suspicious link/message. This has been reported.",
    scamFinal: "Due to detected scam content you’ll be removed from friends.",
    noCashTrades: "I don’t accept money/cash trades. Please send a Steam trade offer for CS2/TF2 items."
  },

  webhook: {
    enabled: false,
    url: "",
    discordEmbeds: true,
    onlyOnImportant: true
  }
};
export function loadConfig() {
  const cfgPath = path.join(ROOT, "config.json");
  const cfg = fs.existsSync(cfgPath)
    ? deepMerge(structuredClone(defaultCfg), JSON.parse(fs.readFileSync(cfgPath, "utf8")))
    : structuredClone(defaultCfg);

  // attach resolved paths
  cfg._paths = {
    ROOT,
    ALLOWLIST: path.join(ROOT, cfg.allowlistFile || defaultCfg.allowlistFile),
    DATA: path.join(ROOT, "data"),
    LOGS: path.join(ROOT, cfg.logging?.dir || defaultCfg.logging.dir),
    SENTRY: path.join(ROOT, cfg.account?.sentryFile || defaultCfg.account.sentryFile),
    LOGINKEY: path.join(ROOT, cfg.account?.loginKeyFile || defaultCfg.account.loginKeyFile),
    REFRESH: path.join(ROOT, "data", "refreshToken.txt"),
    RULES: path.join(ROOT, cfg.rules || defaultCfg.rules)
  };

  // ensure dirs
  if (!fs.existsSync(cfg._paths.DATA)) fs.mkdirSync(cfg._paths.DATA, { recursive: true });
  if (!fs.existsSync(cfg._paths.LOGS)) fs.mkdirSync(cfg._paths.LOGS, { recursive: true });

  // load rules file (hot-reload in place)
  cfg._rules = fs.existsSync(cfg._paths.RULES)
    ? JSON.parse(fs.readFileSync(cfg._paths.RULES, "utf8"))
    : { allowedDomains: ["steamcommunity.com","steampowered.com","discord.com","cs.money"], denyTLDs: [], urlHints: [], blockedKeywords: [], maxLinksPerMessage: 3 };

  fs.watchFile(cfg._paths.RULES, { interval: 1500 }, () => {
    try { cfg._rules = JSON.parse(fs.readFileSync(cfg._paths.RULES, "utf8")); } catch { /* keep last good */ }
  });

  return cfg;
}

export function saveConfig(cfg) {
  const pathOut = path.join(cfg._paths.ROOT, "config.json");
  const clean = JSON.parse(JSON.stringify(cfg, (k, v) => k.startsWith("_") ? undefined : v));
  fs.writeFileSync(pathOut, JSON.stringify(clean, null, 2));
}

// tiny deep merge so user config overrides defaults cleanly
function deepMerge(base, override) {
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) base[k] = deepMerge(base[k] || {}, v);
    else base[k] = v;
  }
  return base;
}
