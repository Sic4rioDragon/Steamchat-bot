// webhook.js — keep it tiny; send JSON or a single embed.

export function createWebhook(cfg, log) {
  async function send(payload){
    try{
      if (!cfg.webhook?.enabled || !cfg.webhook?.url) return;
      const important = ["scam_removed","trade_offer_link","allowlist_bootstrap","friend_accept"];
      if (cfg.webhook.onlyOnImportant && !important.includes(payload.type)) return;

      if (cfg.webhook.discordEmbeds){
        const embed = makeEmbed(payload);
        await fetch(cfg.webhook.url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ username:"Steam Bot", embeds:[embed] }) });
      } else {
        await fetch(cfg.webhook.url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ ts: new Date().toISOString(), ...payload }) });
      }
    }catch(e){ log.warn("Webhook failed: "+(e?.message||e)); }
  }

  function makeEmbed(p){
    const titleMap={friend_accept:"New Friend Accepted",trade_offer_link:"Trade Offer Link Detected",scam_removed:"User Removed for Scam Pattern",allowlist_bootstrap:"Allowlist Bootstrapped"};
    const colorMap={friend_accept:0x2ecc71,trade_offer_link:0x3498db,scam_removed:0xe74c3c,allowlist_bootstrap:0xf1c40f};
    const e={ title:titleMap[p.type]||"Event", color:colorMap[p.type]||0x95a5a6, timestamp:new Date().toISOString(), fields:[] };
    if (p.steamID) e.fields.push({ name:"SteamID64", value:String(p.steamID), inline:true });
    if (p.reason)   e.fields.push({ name:"Reason", value:String(p.reason).slice(0,1024), inline:false });
    if (p.urls?.length) e.fields.push({ name:"URLs", value:p.urls.slice(0,5).join("\n").slice(0,1024), inline:false });
    if (p.count!==undefined) e.fields.push({ name:"Count", value:String(p.count), inline:true });
    return e;
  }

  return { send };
}
