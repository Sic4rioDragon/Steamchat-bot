// commands.js — owner/manager DM commands (keep it minimal & friendly)

export function createCommands(cfg, log, allowlist, msg) {
  function controllers() {
    const set = new Set([...(cfg.admin.ownerIDs||[]), ...(cfg.admin.managerIDs||[])].map(String));
    return set;
  }

  async function handleDirectMessage(steamID, text) {
    const ctrls = controllers();
    if (!ctrls.has(String(steamID))) return false; // not a controller

    if (!text.startsWith("!")) { log.info("Owner/manager message ignored (not a command)."); return true; }

    const parts = text.trim().split(/\s+/);
    const root = parts[0].toLowerCase(); // e.g., !allowlist
    const cmd  = parts[1]?.toLowerCase();

    if (root === "!allowlist") {
      if (cmd === "add") {
        const id = parts[2];
        const name = parts.slice(3).join(" ") || "Manual";
        if (!id) { await msg.safeSend(steamID, "Usage: !allowlist add <steamID64> <name...>"); return true; }
        allowlist.upsert(id, name);
        await msg.safeSend(steamID, `Allowlisted: ${id} (${name}).`);
        return true;
      }
      if (cmd === "remove") {
        const id = parts[2];
        if (!id) { await msg.safeSend(steamID, "Usage: !allowlist remove <steamID64>"); return true; }
        if (allowlist.remove(id)) { await msg.safeSend(steamID, `Removed from allowlist: ${id}.`); }
        else { await msg.safeSend(steamID, `ID not found: ${id}.`); }
        return true;
      }
      if (cmd === "list") {
        const count = allowlist.data.entries.length;
        const sample = allowlist.data.entries.slice(0, 10).map(e => `${e.steamID} ${e.name}`).join("\n") || "(empty)";
        await msg.safeSend(steamID, `Allowlist count: ${count}\n${sample}`);
        return true;
      }
      await msg.safeSend(steamID, "Commands: !allowlist add|remove|list");
      return true;
    }

    // other commands can go here later (!say, !kick, !whois, etc.)

    return true; // was a controller; handled/no-op
  }

  return { handleDirectMessage };
}
