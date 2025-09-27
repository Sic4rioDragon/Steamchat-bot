// state.js — tiny JSON "db" so we remember who we greeted etc.

import fs from "fs";
import path from "path";

export function createStateStore(cfg, log) {
  const file = path.join(cfg._paths.DATA, "state.json");
  let data = { greeted: [], warnedAt: {}, moneyReplyAt: {} };

  try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}

  const greeted = new Set(data.greeted || []);
  const warnedAt = new Map(Object.entries(data.warnedAt || {}).map(([k,v]) => [k, Number(v)]));
  const moneyReplyAt = new Map(Object.entries(data.moneyReplyAt || {}).map(([k,v]) => [k, Number(v)]));

  function persist() {
    try {
      const out = {
        greeted: Array.from(greeted),
        warnedAt: Object.fromEntries(warnedAt.entries()),
        moneyReplyAt: Object.fromEntries(moneyReplyAt.entries())
      };
      fs.writeFileSync(file, JSON.stringify(out, null, 2));
    } catch (e) { log.warn("Failed to persist state: " + e.message); }
  }
  setInterval(persist, 5000);
  process.on("exit", persist);
  process.on("SIGINT", () => { persist(); process.exit(0); });

  return { greeted, warnedAt, moneyReplyAt, persist };
}
