import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
const f = new HTTPFacilitatorClient(createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET));
try {
  const s = await f.getSupported();
  for (const k of s.kinds) console.log(`v${k.x402Version} ${k.scheme} ${k.network}`, k.network.startsWith("solana") ? JSON.stringify(k.extra) : "");
} catch (e) { console.log("ERROR:", e.message?.slice(0, 300)); }
