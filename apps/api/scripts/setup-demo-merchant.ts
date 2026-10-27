/**
 * Idempotent setup for the hosted DEMO merchant (devnet). Creates fresh keys, funds them, creates the demo campaign under the
 * LIVE attribution key, writes the Render env file, and registers a merchant-signed directory listing (isSample = true).
 * Secrets go only to git-ignored files under .secrets/ and .env.render.merchant; the console prints public keys only.
 * Usage (from apps/api):  pnpm setup-demo-merchant   [--skip-listing]
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import bs58 from "bs58";
import { idl, signListing, type Listing } from "@noux/core";

const ROOT = path.resolve(import.meta.dirname, "../../..");
process.loadEnvFile(path.join(ROOT, ".env"));
const SECRETS = path.join(ROOT, ".secrets"); fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
const API_URL = (process.env.API_URL ?? "https://noux-api.onrender.com").replace(/\/$/, "");
const DEMO_URL = (process.env.DEMO_URL ?? "https://noux-demo-merchant.onrender.com").replace(/\/$/, "");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PROGRAM = new PublicKey((idl as any).address);
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));

function key(name: string): Keypair {
  const f = path.join(SECRETS, `${name}.json`);
  if (fs.existsSync(f)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
  const k = Keypair.generate(); fs.writeFileSync(f, JSON.stringify([...k.secretKey]), { mode: 0o600 }); return k;
}
const merchant = key("demo-merchant"), payer = key("demo-gateway-payer"), feeOwner = key("demo-fee");
async function topUp(to: PublicKey, minLamports: number, amount: number) {
  if ((await conn.getBalance(to)) >= minLamports) return;
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: Math.round(amount * 1e9) })), [funder]);
}
await topUp(merchant.publicKey, 20_000_000, 0.05); await topUp(payer.publicKey, 200_000_000, 0.5);
for (const o of [merchant, feeOwner]) await getOrCreateAssociatedTokenAccount(conn, funder, USDC, o.publicKey); // payee/fee token accounts must exist before x402 can pay them

// campaign (once)
const campFile = path.join(SECRETS, "demo-campaign.txt");
const attestPub = new PublicKey(fs.readFileSync(path.join(SECRETS, "pubkeys.txt"), "utf8").split("\n")[0].trim()); // the LIVE API's attribution key
let campaign: PublicKey;
if (fs.existsSync(campFile)) campaign = new PublicKey(fs.readFileSync(campFile, "utf8").trim());
else {
  const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" }));
  const id = new anchor.BN(crypto.randomBytes(6));
  [campaign] = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROGRAM);
  await program.methods.createCampaign(id, 1500, 100, new anchor.BN(5_000_000), attestPub, [...Buffer.from("devnet\0\0")], 15)
    .accounts({ merchant: merchant.publicKey, mint: USDC, feeOwner: feeOwner.publicKey, campaign, systemProgram: SystemProgram.programId }).signers([merchant]).rpc();
  fs.writeFileSync(campFile, campaign.toBase58() + "\n", { mode: 0o600 });
}

// Render env file for the demo-merchant service (git-ignored)
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const lines = [
  `RPC_URL=${env.RPC_URL}`, `PROGRAM_ID=${PROGRAM.toBase58()}`, "CLUSTER=devnet", `CAMPAIGN=${campaign.toBase58()}`, `MINT=${USDC.toBase58()}`,
  `MERCHANT_PAYTO=${merchant.publicKey.toBase58()}`, `GATEWAY_PAYER_B58=${bs58.encode(payer.secretKey)}`, `MERCHANT_SIGNER_B58=${bs58.encode(merchant.secretKey)}`,
  "FACILITATOR=cdp", `CDP_API_KEY_ID=${env.CDP_API_KEY_ID}`, `CDP_API_KEY_SECRET=${env.CDP_API_KEY_SECRET}`, `CLAIMS_API_URL=${API_URL}`, `PUBLIC_URL=${DEMO_URL}`,
];
if (!process.argv.includes("--no-env")) fs.writeFileSync(path.join(ROOT, ".env.render.merchant"), lines.join("\n") + "\n", { mode: 0o600 }); // --no-env: local test runs must not overwrite the deploy file with localhost URLs

console.log("demo campaign      :", campaign.toBase58());
console.log("demo merchant      :", merchant.publicKey.toBase58(), "(campaign merchant + payee)");
console.log("demo gateway payer :", payer.publicKey.toBase58(), `(${(await conn.getBalance(payer.publicKey)) / 1e9} SOL)`);
console.log("demo protocol fee  :", feeOwner.publicKey.toBase58());
console.log(process.argv.includes("--no-env") ? "env file           : untouched (--no-env)" : "env file           : .env.render.merchant (git-ignored)");

// merchant-signed listing (isSample = true), unless the API doesn't have the route yet
if (!process.argv.includes("--skip-listing")) {
  const listing: Listing = {
    name: "Noux sample merchant", category: "data-feeds", isSample: true, route: "GET /sample/brief", displayPrice: "$0.03-$0.10", endpointUrl: `${DEMO_URL}/sample/brief`,
    description: "SAMPLE service by the Noux team: generated demo data behind x402. Use it to try a referral purchase end to end. Not real market data.", website: DEMO_URL,
  };
  const ts = Math.floor(Date.now() / 1000), sig = signListing(merchant.secretKey, { campaign, listing, ts });
  const res = await fetch(`${API_URL}/v1/campaigns/${campaign.toBase58()}/listing`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ listing, ts, signature: Buffer.from(sig).toString("base64") }) });
  const body = await res.json().catch(() => ({})) as any;
  console.log(`listing PUT ${API_URL}: HTTP ${res.status} ${body?.error ? `${body.error.code}: ${body.error.message}` : ""} ${res.status === 404 && !body?.error ? "(API may not be deployed with the listing route yet; rerun after deploy)" : ""}`);
}

process.exit(0); // web3.js keeps a websocket open after confirmations; exit explicitly
