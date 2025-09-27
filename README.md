# Sic4rioDragon Steam Chat Bot

## What this bot does (Overview)

Tired of sorting real traders from scammers in Steam chat? This Windows-friendly bot takes the repetitive work off your hands:

- **Auto-accept (optional)** new friend requests, then **send a one-time welcome** with your rules.
- **Filter junk fast:** detects suspicious links (unicode/punycode look-alikes, deny-TLDs, hint keywords, link floods) and **politely warns then removes** offenders. Optional blocking too.
- **No-cash-trades stance:** if someone mentions cash/PayPal/crypto, the bot replies once (per user, per 12h) that you **don’t do money trades**—please use Steam trade offers.
- **Manual-only allowlist:** nobody gets “trusted” automatically. You add/remove via a DM command or by editing `allowlist.json`.
- **Stable login:** scan a QR once to store a **refresh token**; from then on the bot logs in silently (no more Steam Guard prompts).
- **Safe pacing:** built-in **rate limiter** to avoid message spam and rate limits.
- **Useful logs:** daily log files plus a `flags.csv` with details of flagged messages.
- **Webhook support:** optional Discord-style webhook notifications for accepts, trade-offer links, and removals.
- **Security-first options:** Windows DPAPI encryption for the refresh token if available, or simple NTFS ACL lockdown if not.

**Who is it for?**  
Traders and creators who want their Steam DMs cleaner, faster, and less annoying—especially if you get hit with spam/scam waves and just want to focus on legit CS2/TF2 trades.

---
[![Open Issues](https://img.shields.io/github/issues/Sic4rioDragon/Steamchat-bot)](https://github.com/Sic4rioDragon/Steamchat-bot/issues)

---

## Requirements

- **Windows 10/11**
- **Node.js 20+** (22/24 recommended)
- Steam account for the bot
- (Optional) Discord webhook URL if you want notifications
- (Optional) `win-dpapi` for encrypting the refresh token at rest *(requires MS Build Tools; you can skip it — see Security)*

---

## Install

```powershell
npm i
````

First start (you will scan a QR from the Steam mobile app):

```powershell
npm run start
```

The console prints a **QR image URL**. Open it, scan with the **Steam** mobile app, approve. The bot saves a refresh token to `data/refreshToken.txt` and will auto-login next time.

---

## Start / Stop

```powershell
npm run start
# Ctrl+C to stop
```

Logs go to `./logs/YYYY-MM-DD.log` and flagged messages to `./logs/flags.csv`.

---

## Configure (everything is in `config.json`)

Use this full example and edit the values:

```json
{
  "allowlistFile": "allowlist.json",
  "rules": "rules.json",

  "account": {
    "username": "your_steam_username",
    "password": "your_steam_password",
    "rememberPassword": true,
    "twoFASharedSecret": "",
    "sentryFile": "data/sentry.bin",
    "loginKeyFile": "data/loginKey.txt"
  },

  "admin": {
    "ownerIDs": [],
    "managerIDs": [],
    "consoleCommands": true,
    "autoAddSelfAsOwner": true
  },

  "behavior": {
    "autoAcceptFriends": true,
    "sendWelcomeOnAccept": true,
    "sendWelcomeOncePerUser": true,

    "pollFriendInvitesMs": 60000,

    "relogin": { "enabled": true, "baseMs": 5000, "maxMs": 300000 },

    "cooldowns": { "welcomeMs": 1000, "minBetweenWarningsMs": 30000 },

    "blockScamSender": false
  },

  "rateLimiter": { "maxPerMinute": 12, "burst": 4 },

  "scanner": {
    "moneyKeywords": [
      "cash","money","paypal","skrill","revolut","crypto",
      "btc","eth","usdt","sell for","buy for","real money","irl money"
    ]
  },

  "messages": {
    "welcome": "Hi! I'm an automatic assistant/Bot made by Sic4rioDragon https://github.com/Sic4rioDragon/Steamchat-bot.\n• Tell me briefly why you added me.\n• Trades: Feel free to send a Steam trade offer. I don't do cash trades. If I'm actively trading CS2/TF2 items and the offer is fair, I'll accept.\n• \"Gift\" trades (you send items without me agreeing to return anything) will be treated as gifts and **are not refundable**.\n• If we know each other, say from where. Thanks!",
    "langPleaseEnglish": "English not detected — please write in English, thanks!",
    "scamWarning": "You sent a suspicious link/message. This has been reported.",
    "scamFinal": "Due to detected scam content you’ll be removed from friends.",
    "noCashTrades": "I don’t accept money/cash trades. Please send a Steam trade offer for CS2/TF2 items."
  },

  "webhook": {
    "enabled": false,
    "url": "",
    "discordEmbeds": true,
    "onlyOnImportant": true
  },

  "logging": {
    "dir": "logs",
    "logFlagsToCsv": true
  }
}
```

### What each setting means

```text
allowlistFile            Path to your allowlist JSON (manual-only). The bot never auto-adds users.
rules                    Path to rules JSON used by the URL/keyword scanner (hot-reloaded).

[account]
  username/password      Your Steam credentials (used ONLY if no refresh token exists yet).
  rememberPassword       Leave true; harmless with refresh tokens.
  twoFASharedSecret      Optional — generates 2FA codes for the first login if you prefer TOTP.
  sentryFile             Machine auth file path (created automatically).
  loginKeyFile           Legacy login key (not used when refresh token is present).

[admin]
  ownerIDs               SteamID64s with full control. If empty, bot auto-fills with its own SteamID on first login.
  managerIDs             Additional controllers (can run commands) — ideal if bot runs on a trade account.
  consoleCommands        If true, allows future local console controls (placeholder).
  autoAddSelfAsOwner     Auto-populate ownerIDs with the bot account if ownerIDs is empty.

[behavior]
  autoAcceptFriends      If true, accepts all incoming friend requests.
  sendWelcomeOnAccept    If true, sends welcome to new friends (with retries).
  sendWelcomeOncePerUser One-time welcome per user (also sent on their first DM if missed earlier).
  pollFriendInvitesMs    Fallback poll interval to catch pending invites.
  relogin.baseMs/maxMs   Reconnect backoff (ms).
  cooldowns.welcomeMs    Initial delay before welcome attempt.
  cooldowns.minBetweenWarningsMs  Cooldown between scam warnings to the same user.
  blockScamSender        If true, block users after removal for scam.

[rateLimiter]
  maxPerMinute/burst     Token bucket for message sending.

[scanner]
  moneyKeywords          Words that trigger the polite "no cash trades" reply (12h per-user cooldown).

[messages]
  welcome                Your welcome text (supports newlines).
  langPleaseEnglish      Reply when the message isn't English/German.
  scamWarning            First warning line for suspicious messages.
  scamFinal              Final message before removal.
  noCashTrades           Auto-reply when cash/PayPal/crypto is mentioned.

[webhook]
  enabled/url            If enabled, send JSON/embeds to your webhook URL.
  discordEmbeds          Use Discord embed format if true.
  onlyOnImportant        If true, only send key events (accept, trade link, scam removed).

[logging]
  dir                    Log directory.
  logFlagsToCsv          If true, append suspicious events to logs/flags.csv.
```

---

## Commands (via DM from owner/manager accounts)

```text
!allowlist add <steamID64> <name...>
!allowlist remove <steamID64>
!allowlist list
```

* Non-command DMs from owners/managers are ignored (by design).
* Add controller SteamIDs in `admin.managerIDs`.

---

## Rules (`rules.json`) example

```json
{
  "allowedDomains": ["steamcommunity.com", "steampowered.com", "discord.com", "cs.money"],
  "denyTLDs": ["ru", "top", "xyz"],
  "urlHints": ["steamcommunity.ru", "steampowered.help", "free-knife", "gift-case"],
  "blockedKeywords": ["free knife", "free csgo", "boosting service"],
  "maxLinksPerMessage": 3
}
```

The file is hot-reloaded — edits apply without restarting.

---

## Security

```powershell
# If you DON'T install DPAPI, the refresh token is plaintext at data/refreshToken.txt.
# Lock down NTFS ACLs:
icacls data /inheritance:r
icacls data /grant:r "$env:USERNAME":(OI)(CI)F SYSTEM:(OI)(CI)F

# OPTIONAL: use DPAPI (requires MSVC build tools; if installed, bot auto-encrypts)
# npm i win-dpapi
```

---

## Troubleshooting

```text
RateLimitExceeded         Bot auto-backs off ~15–25 minutes; avoid restart-spam.
SteamGuard prompt again   You likely deleted data/refreshToken.txt; start once more and scan a fresh QR.
No welcomes after restart Bot runs a startup sweep and greets missing new friends; check logs.
```
## Contributing & Issues

Got an idea, found a bug, or want to improve something?

- **Open an issue:** https://github.com/Sic4rioDragon/Steamchat-bot/issues
- **Feature requests:** clearly describe the problem, your use case, and the desired outcome.
- **Bug reports:** include steps to reproduce, logs from `./logs/`, your `Node.js` version, and OS details.

PRs are welcome. Keep changes focused, add a short rationale, and test locally before opening.
```
::contentReference[oaicite:0]{index=0}
```
