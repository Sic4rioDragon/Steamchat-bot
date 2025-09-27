// rateLimiter.js — keep Steam happy; don't spam messages.

export function createRateLimiter(cfg) {
  let tokens = cfg.rateLimiter?.burst ?? 4;
  let last = Date.now();

  function canSendNow() {
    const perMin = cfg.rateLimiter?.maxPerMinute ?? 12;
    const burst  = cfg.rateLimiter?.burst ?? 4;
    const now = Date.now();
    const elapsed = (now - last) / 60000;
    const refill = elapsed * perMin;
    if (refill > 0) { tokens = Math.min(burst, tokens + refill); last = now; }
    if (tokens >= 1) { tokens -= 1; return true; }
    return false;
  }

  return { canSendNow };
}
