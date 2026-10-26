import { createAuthHeader } from "@coinbase/x402";
import fs from "fs";
const id = process.env.CDP_API_KEY_ID, secret = process.env.CDP_API_KEY_SECRET;
const host = "api.cdp.coinbase.com", path = "/platform/v2/x402/discovery/resources";
const out = []; let offset = 0;
for (let page = 0; page < 60; page++) {
  const a = await createAuthHeader(id, secret, "GET", host, path);
  const r = await fetch(`https://${host}${path}?limit=100&offset=${offset}`, { headers: { Authorization: a.startsWith("Bearer") ? a : `Bearer ${a}` } });
  if (!r.ok) { console.error("HTTP", r.status, (await r.text()).slice(0, 300)); break; }
  const j = await r.json(); const items = j.items ?? j.resources ?? [];
  if (page === 0) console.log("keys:", Object.keys(j), "total:", j.pagination?.total ?? j.total);
  out.push(...items); if (items.length < 100) break; offset += 100;
}
fs.writeFileSync(process.argv[2], JSON.stringify(out)); console.log("fetched", out.length);
