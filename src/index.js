// index.js — boot it up nice and simple.

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createRateLimiter } from "./rateLimiter.js";
import { createStateStore } from "./state.js";
import { createAllowlist } from "./allowlist.js";
import { createScanner } from "./scanner.js";
import { createMessenger } from "./messages.js";
import { createWebhook } from "./webhook.js";
import { setupLogin } from "./login.js";
import { wireEvents } from "./events.js";
import { createCommands } from "./commands.js";

import SteamUser from "steam-user";
import SteamCommunity from "steamcommunity";

const ctx = {};

// load config + rules (hot-reloads rules internally)
ctx.cfg = loadConfig();

// core clients
ctx.client = new SteamUser();
ctx.community = new SteamCommunity();

// logging, state, rate limiter, webhook
ctx.log = createLogger(ctx.cfg);
ctx.state = createStateStore(ctx.cfg, ctx.log);
ctx.rate = createRateLimiter(ctx.cfg);
ctx.webhook = createWebhook(ctx.cfg, ctx.log);

// data domains
ctx.allowlist = createAllowlist(ctx.cfg, ctx.log);
ctx.scanner = createScanner(ctx.cfg, ctx.log);
ctx.msg = createMessenger(ctx.cfg, ctx.log, ctx.rate, ctx.client, ctx.community, ctx.state);

// attach cross refs for convenience (used in messenger & elsewhere)
ctx.cfg._allowlist = ctx.allowlist;
ctx.cfg._scanner = ctx.scanner;

// commands (owner/manager)
ctx.cmd = createCommands(ctx.cfg, ctx.log, ctx.allowlist, ctx.msg);

// wire everything
setupLogin(ctx);          // QR/refresh token + reconnect/backoff
wireEvents(ctx);          // Steam events (relationship, messages, poller, renames, sweeps)

// and… go
ctx.log.info("Sic4rioDragon bot — started (modular).");
