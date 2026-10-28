/**
 * Remove a campaign from the public directory, signed by its merchant key (the campaign stays on-chain).
 *   API_URL=https://noux-api.onrender.com MERCHANT_KEY=.secrets/demo-merchant.json pnpm tsx scripts/unlist-campaign.ts <campaign>
 */
import fs from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { signUnlist } from "@noux/core";

const api = (process.env.API_URL ?? "https://noux-api.onrender.com").replace(/\/$/, "");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.MERCHANT_KEY!, "utf8"))));
const campaign = new PublicKey(process.argv[2]);
const ts = Math.floor(Date.now() / 1000);
const sig = signUnlist(kp.secretKey, { campaign, ts });
const res = await fetch(`${api}/v1/campaigns/${campaign.toBase58()}/listing`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ ts, signature: Buffer.from(sig).toString("base64") }) });
console.log(res.status, JSON.stringify(await res.json().catch(() => ({}))));
process.exit(res.ok ? 0 : 1);
