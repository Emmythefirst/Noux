/**
 * The pause lifecycle on the LIVE devnet system (live API, live demo merchant, live program), reversible: it only pauses and resumes, never ends.
 *   claim issued BEFORE the pause -> pause (merchant key) -> claim service refuses (409) -> the live gateway turns the old claim into a PLAIN purchase
 *   (merchant paid in full, no sale) -> a direct on-chain open_sale with that old claim is refused by the PROGRAM -> resume -> a new referred purchase settles.
 * It always tries to resume, even when a step fails. Costs two real 0.10 USDC purchases and about 0.001 SOL.
 *   set -a; . ../../.env; set +a; NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000 pnpm tsx scripts/live-pause-check.ts
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme as ExactSvmClient } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { BRAND, idl, signClaimRequest, claimFromWire, salePda, type ClaimWire } from "@noux/core";
import { AnchorChain, encodeClaimHeader } from "@noux/gateway";

process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
const ROOT = path.resolve(import.meta.dirname, "../../..");
const API = "https://noux-api.onrender.com", MERCHANT_URL = "https://noux-demo-merchant.onrender.com", ROUTE = "/sample/brief";
const load = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
const buyer = load(path.join(os.homedir(), ".config/solana/id.json")), merchantKey = load(path.join(ROOT, ".secrets/demo-merchant.json")), distributor = load(path.join(ROOT, "spike/keys/distributor.json"));
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const PROGRAM = new PublicKey((idl as any).address), USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean }[] = []; const rec = (name: string, ok: boolean, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const info = await (await fetch(`${MERCHANT_URL}/v1/info`)).json() as any; const campaign = new PublicKey(info.campaign); const PRICE = BigInt(info.routes.find((r: any) => r.route === `GET ${ROUTE}`).price);
const controlPda = PublicKey.findProgramAddressSync([Buffer.from("control"), campaign.toBuffer()], PROGRAM)[0];
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(merchantKey), { commitment: "confirmed" }));
const setState = (s: "active" | "paused") => program.methods.setCampaignState({ [s]: {} } as any).accounts({ merchant: merchantKey.publicKey, campaign, control: controlPda, systemProgram: SystemProgram.programId } as any).signers([merchantKey]).rpc();
const apiState = async () => ((await (await fetch(`${API}/v1/campaigns/${campaign.toBase58()}`)).json()) as any).state;
const claimReq = async () => { const ts = Math.floor(Date.now() / 1000), sig = signClaimRequest(buyer.secretKey, { campaign, distributor: distributor.publicKey, buyer: buyer.publicKey, price: PRICE, ts }); return fetch(`${API}/v1/claims`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ campaign: campaign.toBase58(), distributor: distributor.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(), price: PRICE.toString(), ts, buyerSignature: Buffer.from(sig).toString("base64") }) }); };
const pay = wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmClient(await createKeyPairSignerFromBytes(buyer.secretKey))));
const merchantAta = getAssociatedTokenAddressSync(USDC, new PublicKey(info.merchantPayTo ?? merchantKey.publicKey), true);
const bal = async () => { try { return (await getAccount(conn, merchantAta)).amount; } catch { return 0n; } };
const buy = async (claim?: ClaimWire) => { for (let i = 0; i < 4; i++) { const r = await pay(`${MERCHANT_URL}${ROUTE}`, { headers: claim ? { [BRAND.claimHeader]: encodeClaimHeader(claim) } : {} }); const b = await r.text(); if (r.status === 200 || !/fetch failed/.test(b)) return r.status; await sleep(2000); } return -1; };
const until = async (f: () => Promise<boolean>, ms: number, every = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return true; await sleep(every); } return false; };

if ((await conn.getBalance(merchantKey.publicKey)) < 10_000_000) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: merchantKey.publicKey, lamports: 20_000_000 })), [buyer]);
console.log(`campaign ${campaign.toBase58()} (live demo), state now: ${await apiState()}`);
let paused = false;
try {
  const r0 = await claimReq(); rec("before the pause: a claim is issued (201)", r0.status === 201); const oldWire = (await r0.json() as any).claim as ClaimWire, oldClaim = claimFromWire(oldWire);
  await setState("paused"); paused = true; rec("the merchant pauses the live campaign on devnet", true);
  rec("the API's campaign card says paused (the index catches up)", await until(async () => (await apiState()) === "paused", 150_000));
  const refused = await until(async () => (await claimReq()).status === 409, 90_000, 6000); const r1 = await claimReq(); const j1 = await r1.json() as any;
  rec("paused: the claim service refuses new claims with 409 campaign_not_active", refused || (r1.status === 409 && j1.error?.code === "campaign_not_active"), `${r1.status} ${j1.error?.code ?? ""}`);
  const salePk = salePda(PROGRAM, campaign, oldClaim.nonce); const before = await bal();
  const st = await buy(oldWire); await sleep(4000); const after = await bal();
  rec("paused: the live gateway turns the OLD (still valid) claim into a plain purchase: HTTP 200", st === 200, `status ${st}`);
  rec("...the merchant was paid the FULL price and no sale was opened", after - before === PRICE && (await conn.getAccountInfo(salePk, "confirmed")) === null, `merchant +${after - before} of ${PRICE}`);
  let direct = ""; try { await new AnchorChain({ connection: conn, programId: PROGRAM, mint: USDC, gatewayPayer: buyer }).ensureOpen(oldClaim); direct = "SUCCEEDED"; } catch (e) { direct = String((e as Error).message) + " " + ((e as any).logs ?? []).join(" "); }
  rec("paused: a DIRECT on-chain open_sale with that old valid claim is refused by the PROGRAM itself", /CampaignNotActive|paused or ended/i.test(direct), direct.slice(0, 90));
  await setState("active"); paused = false; rec("the merchant resumes", true);
  rec("the API's campaign card says active again", await until(async () => (await apiState()) === "active", 150_000));
  const fresh = await until(async () => (await claimReq()).status === 201, 90_000, 6000); rec("resumed: the claim service issues claims again", fresh);
  const r2 = await claimReq(); const wire2 = (await r2.json() as any).claim as ClaimWire; const claim2 = claimFromWire(wire2);
  const st2 = await buy(wire2); rec("resumed: a referred purchase works through the live gateway (200)", st2 === 200, `status ${st2}`);
  const sale2 = salePda(PROGRAM, campaign, claim2.nonce).toBase58(); let receipt: any = null;
  for (let i = 0; i < 40 && !receipt; i++) { await sleep(4000); const x = await fetch(`${API}/v1/receipts/${sale2}`); if (x.status === 200) { const j = await x.json() as any; if (j.status === "settled") receipt = j; } }
  rec("...and it settles with the exact split 84000 / 15000 / 1000", !!receipt && receipt.split.merchant === "84000" && receipt.split.distributor === "15000" && receipt.split.protocolFee === "1000", receipt ? JSON.stringify(receipt.split) : "no receipt");
} finally {
  if (paused) { try { await setState("active"); console.log("(safety) campaign resumed after a failure"); } catch (e) { console.log("!!! COULD NOT RESUME the live campaign; run setCampaignState active with the demo merchant key:", String(e).slice(0, 100)); } }
}
const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} checks passed; live campaign state at the end: ${await apiState()}`); process.exit(failed.length ? 1 : 0);
