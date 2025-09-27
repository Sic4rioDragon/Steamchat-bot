// scanner.js — cheap but decent filters (unicode/punycode, link count, money words).

import punycode from "punycode";

export function createScanner(cfg, log) {
  const RULES = () => cfg._rules; // hot-reloaded by config.js
  const URL_RE = /\b((?:https?:\/\/)?[a-z0-9\-._~%]+(?:\.[a-z0-9\-._~%]+)+(?:\/[^\s]*)?)\b/ig;

  const MONEY_KWS = (cfg.scanner?.moneyKeywords && cfg.scanner.moneyKeywords.length)
    ? cfg.scanner.moneyKeywords.map(s => s.toLowerCase())
    : ["cash","money","paypal","skrill","revolut","crypto","btc","eth","usdt","sell for","buy for","real money","irl money"];

  function hostname(u){ try{ const url=new URL(u.startsWith("http")?u:"https://"+u); return url.hostname.toLowerCase(); }catch{ return ""; } }
  function normalizeUrl(u){ return /^https?:\/\//i.test(u) ? u : "https://"+u; }
  function toASCII(h){ try{ return punycode.toASCII(h); }catch{ return h; } }
  function typosLike(h,b){ const H=h.replace(/[0-9oO]/g,"o").replace(/[lI1]/g,"l"); const B=b.replace(/[0-9oO]/g,"o").replace(/[lI1]/g,"l"); return H.includes(B) && H!==B && H.length<=B.length+6; }
  function looksPhishy(host,xn){ if(!host||!xn) return false; const bases=["steam","steampowered","steamcommunity","discord","cs.money","csmoney"]; return bases.some(b=>typosLike(host,b)||typosLike(xn,b)); }

  function isEnglishOrGerman(t){
    t = t.toLowerCase();
    const de=["und","ich","nicht","bitte","danke","hallo","warum","weil","ja","nein","tausche","handel","angebot"];
    const en=[" and "," i ","not","please","thanks","hello","why","because","yes","no","trade","offer"];
    const hasDE = de.some(w=>t.includes(w));
    const hasEN = en.some(w=>t.includes(w));
    const letters=(t.match(/[a-z]/g)||[]).length;
    if(!hasDE && !hasEN && letters>=6) return false;
    return true;
  }

  function scanMessageForScam(message){
    const rules = RULES();
    const urls=[]; let m; while((m=URL_RE.exec(message))!==null) urls.push(normalizeUrl(m[1]));
    const badUrls=[];
    for(const u of urls){
      const host=hostname(u); const xn=toASCII(host); const tld=host.split(".").pop()?.toLowerCase();
      const allowed=(rules.allowedDomains||[]).some(d=>host.endsWith(d));
      const denied=(rules.denyTLDs||[]).includes(tld);
      const hint=(rules.urlHints||[]).some(h=>u.toLowerCase().includes(h));
      if(!allowed && (hint||denied||looksPhishy(host,xn))) badUrls.push(u);
    }
    const low=message.toLowerCase();
    const kw=(rules.blockedKeywords||[]).some(k=>low.includes(k));
    const tooMany=urls.length>(rules.maxLinksPerMessage||3);
    const scam = badUrls.length>0 || kw || tooMany;
    const reason=scam?`badUrls:${badUrls.length} kw:${kw} links:${urls.length}`:"";
    return { scam, reason, urls: badUrls.length?badUrls:urls, anyUrls: urls.length>0 };
  }

  function mentionsMoney(message){
    const low = message.toLowerCase();
    return MONEY_KWS.some(k => low.includes(k));
  }

  return { isEnglishOrGerman, scanMessageForScam, mentionsMoney };
}
