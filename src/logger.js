// logger.js — simple daily file logs; CSV export for flags.

import fs from "fs";
import path from "path";

export function createLogger(cfg) {
  const logsDir = cfg._paths.LOGS;

  function now() { return new Date().toISOString(); }
  function logFile() {
    const d = new Date();
    const f = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}.log`;
    return path.join(logsDir, f);
  }
  function write(level, msg) {
    const line = `[${now()}] [${level}] ${msg}\n`;
    fs.appendFileSync(logFile(), line);
    console.log(line.trim());
  }

  function csvFlag(row) {
    if (!cfg.logging?.logFlagsToCsv) return;
    const csv = path.join(logsDir, "flags.csv");
    if (!fs.existsSync(csv)) fs.writeFileSync(csv, "time,steamID,reason,message,urls\n");
    fs.appendFileSync(csv, [
      now(),
      JSON.stringify(row.steamID ?? ""),
      JSON.stringify(row.reason ?? ""),
      JSON.stringify(row.message ?? ""),
      JSON.stringify((row.urls ?? []).join(" "))
    ].join(",") + "\n");
  }

  return {
    info: (m) => write("INFO", m),
    warn: (m) => write("WARN", m),
    err:  (m) => write("ERR",  m),
    csvFlag
  };
}
