// allowlist.js — ONLY owner/manager command or file edits can add. Everything else updates/removes.

import fs from "fs";

export function createAllowlist(cfg, log) {
  const file = cfg._paths.ALLOWLIST;

  function normalize(obj) {
    if (obj?.entries && Array.isArray(obj.entries)) return obj;
    if (obj?.steamIDs && Array.isArray(obj.steamIDs)) {
      return { entries: obj.steamIDs.map(id => ({ steamID: String(id), name: "Unknown" })) };
    }
    return { entries: [] };
  }

  let data = normalize(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { entries: [] });

  function save() { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {} }

  function isAllowlisted(id) { return data.entries.some(e => e.steamID === String(id)); }
  function upsert(id, name, silent=false) {
    const s = String(id);
    const idx = data.entries.findIndex(e => e.steamID === s);
    if (idx >= 0) {
      if (data.entries[idx].name !== name) { data.entries[idx].name = name; if (!silent) save(); return true; }
      return false;
    } else { data.entries.push({ steamID: s, name }); if (!silent) save(); return true; }
  }
  function updateNameIfPresent(id, name, silent=false) {
    const s = String(id);
    const idx = data.entries.findIndex(e => e.steamID === s);
    if (idx === -1) return false;
    if (data.entries[idx].name !== name) { data.entries[idx].name = name; if (!silent) save(); return true; }
    return false;
  }
  function remove(id) {
    const s = String(id);
    const before = data.entries.length;
    data.entries = data.entries.filter(e => e.steamID !== s);
    const changed = data.entries.length !== before;
    if (changed) save();
    return changed;
  }
  async function pruneAgainstFriends(client) {
    try {
      const friendIds = new Set(
        Object.entries(client.myFriends || {})
          .filter(([, rel]) => rel === client.constructor.EFriendRelationship.Friend)
          .map(([id]) => String(id))
      );
      const before = data.entries.length;
      data.entries = data.entries.filter(e => friendIds.has(String(e.steamID)));
      const removed = before - data.entries.length;
      if (removed > 0) { save(); log.info(`Pruned ${removed} entries from allowlist (no longer friends).`); }
    } catch (e) { log.warn("Allowlist prune failed: " + e.message); }
  }

  async function refreshNames(client) {
    try {
      const ids = data.entries.map(e=>e.steamID);
      if (!ids.length) return;
      const personas = await new Promise(res => client.getPersonas(ids, (_, p) => res(p||{})));
      let changed = 0;
      for (const id of ids) {
        const persona = personas[id]?.player_name || "Unknown";
        const name = persona; // nick override happens elsewhere at display time if needed
        if (updateNameIfPresent(id, name, true)) changed++;
      }
      if (changed) { save(); log.info(`Refreshed names for ${changed} friends.`); }
    } catch (e) { log.warn("Name refresh failed: " + e.message); }
  }

  return { file, data, save, isAllowlisted, upsert, updateNameIfPresent, remove, pruneAgainstFriends, refreshNames };
}
