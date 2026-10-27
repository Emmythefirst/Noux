/**
 * A scripted BUYER AGENT against the deployed system: gets a buyer-signed claim, makes a real x402 call to the demo merchant,
 * then waits for the public receipt. Also shows the two fallbacks (no claim, tampered price).
 * Usage (from apps/api):  pnpm demo-buy   [API_URL=... MERCHANT_URL=... ROUTE=/sample/brief]
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactSvmScheme as ExactSvmClient } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { BRAND, signClaimRequest, claimFromWire, salePda, type ClaimWire } from "@noux/core";
import { encodeClaimHeader } from "@noux/gateway";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const API = (process.env.API_URL ?? "https://noux-api.onrender.com").replace(/\/$/, "");
const MERCHANT = (process.env.MERCHANT_URL ?? "https://noux-demo-merchant.onrender.com").replace(/\/$/, "");
const ROUTE = process.env.ROUTE ?? "/sample/brief";
const load = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
const buyer = load(path.join(os.homedir(), ".config/solana/id.json"));             // devnet wallet holding test USDC
const distributor = load(path.join(ROOT, "spike/keys/distributor.json"));         // the referrer (any public key works; the claim just names it)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(m);

const info = await (await fetch(`${MERCHANT}/v1/info`)).json() as any;
const route = info.routes.find((r: any) => r.route === `GET ${ROUTE}`); if (!route) throw new Error(`route ${ROUTE} not offered`);
log(`service   : ${info.notice ? "SAMPLE service" : "service"} at ${MERCHANT}  (cluster ${info.cluster})`);
log(`route     : GET ${ROUTE}  ${route.displayPrice} (${route.price} base units)   campaign ${info.campaign}`);

async function getClaim(price: bigint): Promise<ClaimWire> {
  const ts = Math.floor(Date.now() / 1000), campaign = new PublicKey(info.campaign);
  const sig = signClaimRequest(buyer.secretKey, { campaign, distributor: distributor.publicKey, buyer: buyer.publicKey, price, ts });
  const r = await fetch(`${API}/v1/claims`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ campaign: info.campaign, distributor: distributor.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(), price: price.toString(), ts, buyerSignature: Buffer.from(sig).toString("base64") }) });
  if (r.status !== 201) throw new Error(`claim request failed: ${r.status} ${await r.text()}`);
  return (await r.json() as any).claim;
}
const pay = wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmClient(await createKeyPairSignerFromBytes(buyer.secretKey))));
async function call(claim?: ClaimWire) {
  for (let i = 1; i <= 4; i++) {
    const r = await pay(`${MERCHANT}${ROUTE}`, { headers: claim ? { [BRAND.claimHeader]: encodeClaimHeader(claim) } : {} });
    const body = await r.text(); const ph = r.headers.get("payment-response");
    if (r.status === 200 || !/fetch failed/.test(body + (r.headers.get("payment-required") ? Buffer.from(r.headers.get("payment-required")!, "base64").toString() : ""))) return { status: r.status, body, tx: ph ? decodePaymentResponseHeader(ph).transaction : undefined };
    await sleep(2000);
  }
  throw new Error("merchant kept failing at the facilitator");
}

// 1. referral purchase
const wire = await getClaim(BigInt(route.price)); const claim = claimFromWire(wire);
log(`\n1) claim issued: buyer ${buyer.publicKey.toBase58().slice(0, 6)}… referrer ${distributor.publicKey.toBase58().slice(0, 6)}… expires in ${claim.expiry - Math.floor(Date.now() / 1000)}s`);
const r1 = await call(wire);
log(`   x402 call: HTTP ${r1.status}  payment tx ${r1.tx ?? "-"}\n   response : ${r1.body.slice(0, 120)}`);
const sale = salePda(new PublicKey(info.programId), new PublicKey(info.campaign), claim.nonce).toBase58();
log(`   sale account ${sale}\n   waiting for the public receipt (indexer ~20s)...`);
let receipt: any = null;
for (let i = 0; i < 30 && !receipt; i++) { await sleep(4000); const x = await fetch(`${API}/v1/receipts/${sale}`); if (x.status === 200) { const j = await x.json() as any; if (j.status === "settled") receipt = j; } }
if (receipt) log(`   RECEIPT  : ${receipt.status}  gross ${receipt.gross}  merchant ${receipt.split.merchant} / referrer ${receipt.split.distributor} / protocol ${receipt.split.protocolFee}\n              settlement ${receipt.links.settlement}\n              payment    ${receipt.links.payment}`);
else log("   (receipt not indexed yet: check GET /v1/receipts/" + sale + " shortly)");

// 2. no claim => plain purchase
const r2 = await call();
log(`\n2) no claim  : HTTP ${r2.status}  (plain purchase: merchant paid in full, no commission)`);

// 3. tampered: ask for a claim at a LOWER price; the gateway must refuse it and charge the real price
const cheap = await getClaim(1_000n);
const r3 = await call(cheap);
log(`3) lower-priced claim: HTTP ${r3.status}  (gateway ignored the claim and charged the real price ${route.displayPrice})`);
log("\ndone. Directory: " + `${API}/v1/campaigns   Stats: ${API}/v1/stats`);

process.exit(0);
