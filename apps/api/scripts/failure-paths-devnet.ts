/**
 * The failure paths, on REAL devnet through the real stack (x402 gateway, CDP facilitator, on-chain program). No database needed.
 *   1. A replayed claim: the same claim used a second time earns nobody a second commission, and cannot open a second sale.
 *   2. A refund inside the hold: the buyer gets the whole payment back; no commission, no fee; the sale can no longer settle.
 *   3. An exhausted budget: the buyer still pays and is served; the commission is capped, then zero; the merchant keeps the rest.
 * Run from apps/api:  pnpm tsx scripts/failure-paths-devnet.ts     Spends about 0.5 devnet USDC (0.1 of it comes straight back).
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import type { AddressInfo } from "node:net";
import express from "express";
import { Connection, Ed25519Program, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactSvmScheme as ExactSvmClient } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { BRAND, configPda, LocalKeySigner, OnchainCampaignReader, idl, salePda, signClaim, claimToWire, type ClaimWire, type SignedClaim } from "@noux/core";
import { AnchorChain, createNouxGateway, encodeClaimHeader, type GatewayEvent } from "@noux/gateway";

// Dev machines (WSL) sometimes fail to resolve one host while public resolvers answer: fall back to 1.1.1.1 for lookups the system could not do.
import dns from "node:dns";
{
  const orig = dns.lookup.bind(dns) as any; const res = new dns.Resolver(); res.setServers(["1.1.1.1", "8.8.8.8"]);
  (dns as any).lookup = (host: string, opts: any, cb: any) => {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    orig(host, opts, (err: any, addr: any, fam: any) => {
      if (!err || !/EAI_AGAIN|ENOTFOUND/.test(err.code)) return cb(err, addr, fam);
      res.resolve4(host, (e2: any, ips: string[]) => (e2 || !ips.length) ? cb(err) : (opts?.all ? cb(null, ips.map((a) => ({ address: a, family: 4 }))) : cb(null, ips[0], 4)));
    });
  };
}
process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
const KEYS = path.resolve(import.meta.dirname, "../../../spike/keys");
const key = (n: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, `${n}.json`), "utf8"))));
const buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const [merchant, distributor, attest] = ["merchant", "distributor", "attribution"].map(key);

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PROGRAM = new PublicKey((idl as any).address);
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const PRICE = 100_000n, COMMISSION_BPS = 1500;
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(buyer), { commitment: "confirmed" }));
const protocolCfg = await (program.account as any).config.fetch(configPda(PROGRAM));
const feeOwner: PublicKey = protocolCfg.feeOwner; const FEE_BPS: number = protocolCfg.feeBps;
const FEE = Number(PRICE) * FEE_BPS / 10000, COM = Number(PRICE) * COMMISSION_BPS / 10000;

const results: { name: string; ok: boolean }[] = [];
const evidence: string[] = [];
const rec = (name: string, ok: boolean, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const tx = (sig?: string) => (sig ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : "(none)");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ata = (o: PublicKey) => getAssociatedTokenAddressSync(USDC, o, true);
const MISSING = /could not find account|TokenAccountNotFound|Invalid param/i;
async function withRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= tries || MISSING.test(String((e as Error).name + (e as Error).message))) throw e; await sleep(1500 * i); } }
}
const bal = async (a: PublicKey) => { try { return Number((await withRetry(() => getAccount(conn, a))).amount); } catch (e) { if (MISSING.test(String((e as Error).name + (e as Error).message))) return 0; throw e; } };
const snap = async () => ({ m: await bal(ata(merchant.publicKey)), d: await bal(ata(distributor.publicKey)), f: await bal(ata(feeOwner)), b: await bal(ata(buyer.publicKey)) });
const saleStatus = async (sale: PublicKey) => { try { return Object.keys(((await withRetry(() => (program.account as any).sale.fetch(sale))) as any).status)[0]; } catch { return "none"; } };
async function waitStatus(sale: PublicKey, want: string, ms = 30_000) { const end = Date.now() + ms; let s = await saleStatus(sale); while (s !== want && Date.now() < end) { await sleep(1500); s = await saleStatus(sale); } return s; }

for (const o of [merchant, distributor]) await getOrCreateAssociatedTokenAccount(conn, buyer, USDC, o.publicKey);
await getOrCreateAssociatedTokenAccount(conn, buyer, USDC, feeOwner);
if ((await conn.getBalance(merchant.publicKey)) < 8_000_000) await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: merchant.publicKey, lamports: 10_000_000 })), [buyer]);

async function newCampaign(budget: bigint, hold: number) {
  const cid = new anchor.BN(crypto.randomBytes(6));
  const [campaign] = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), cid.toArrayLike(Buffer, "le", 8)], PROGRAM);
  await program.methods.createCampaign(cid, COMMISSION_BPS, new anchor.BN(budget.toString()), attest.publicKey, [...Buffer.from("devnet\0\0")], hold)
    .accounts({ merchant: merchant.publicKey, mint: USDC, config: configPda(PROGRAM), campaign, systemProgram: SystemProgram.programId }).signers([merchant]).rpc();
  return campaign;
}
const campaigns = new OnchainCampaignReader(conn, PROGRAM, 1_000, 1_000);
const facilitator = new HTTPFacilitatorClient(createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET));
const chain = new AnchorChain({ connection: conn, programId: PROGRAM, mint: USDC, gatewayPayer: buyer, merchant });
const signer = new LocalKeySigner(attest.secretKey);
const mkClaim = (campaign: PublicKey) => signClaim(signer, { programId: PROGRAM, cluster: "devnet", campaign, distributor: distributor.publicKey, buyer: buyer.publicKey, expiry: Math.floor(Date.now() / 1000) + 600, price: PRICE, nonce: crypto.randomBytes(32) });

async function startGateway(campaign: PublicKey, withSettler: boolean) {
  const events: GatewayEvent[] = [];
  const gw = createNouxGateway({
    programId: PROGRAM, cluster: "devnet", campaign, mint: USDC, network: NET, merchantPayTo: merchant.publicKey, facilitator, connection: conn, campaigns,
    opener: chain, settler: withSettler ? chain : undefined, routes: { "GET /report": { price: PRICE, description: "failure-path demo" } }, onEvent: (e) => { events.push(e); },
  });
  const app = express(); app.use(gw.middleware); app.get("/report", (_q, r) => r.json({ report: "served" }));
  const srv = await new Promise<import("node:http").Server>((res) => { const s = app.listen(0, () => res(s)); });
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, events, close: () => new Promise((r) => srv.close(() => r(null))) };
}
const buyerPay = wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmClient(await createKeyPairSignerFromBytes(buyer.secretKey))));
async function call(url: string, claim?: ClaimWire) {
  for (let i = 1; i <= 4; i++) {
    const r = await buyerPay(`${url}/report`, { headers: claim ? { [BRAND.claimHeader]: encodeClaimHeader(claim) } : {} });
    const txt = await r.text(); const ph = r.headers.get("payment-response");
    if (r.status === 200 || i === 4 || !/fetch failed/.test(txt)) return { status: r.status, body: txt, tx: ph ? decodePaymentResponseHeader(ph).transaction : undefined };
    await sleep(1500);
  }
  throw new Error("unreachable");
}
const delta = (a: Awaited<ReturnType<typeof snap>>, b: Awaited<ReturnType<typeof snap>>) => ({ m: b.m - a.m, d: b.d - a.d, f: b.f - a.f, b: b.b - a.b });
const fmt = (d: { m: number; d: number; f: number; b: number }) => `merchant ${d.m >= 0 ? "+" : ""}${d.m}, distributor ${d.d >= 0 ? "+" : ""}${d.d}, protocol ${d.f >= 0 ? "+" : ""}${d.f}, buyer ${d.b >= 0 ? "+" : ""}${d.b}`;

// =========================== 1. REPLAYED CLAIM ===========================
console.log("\n== 1. A replayed claim ==");
{
  const campaign = await newCampaign(1_000_000_000n, 120);
  evidence.push(`campaign (replay + refund): ${campaign.toBase58()}`);
  const gw = await startGateway(campaign, true);
  const claim = await mkClaim(campaign); const wire = claimToWire(claim); const sale = salePda(PROGRAM, campaign, claim.nonce);

  let b0 = await snap(); const first = await call(gw.url, wire); const st1 = await waitStatus(sale, "settled"); await sleep(1500); let b1 = await snap();
  rec("first use of the claim: served, sale opened and settled with the exact split", first.status === 200 && st1 === "settled" && b1.m - b0.m === Number(PRICE) - FEE - COM && b1.d - b0.d === COM && b1.f - b0.f === FEE, fmt(delta(b0, b1)));
  evidence.push(`replay: first use x402 payment ${tx(first.tx)}`);

  const again = await call(gw.url, wire); await sleep(3000); const b2 = await snap();
  const d2 = delta(b1, b2);
  rec("replay through the gateway: refused (HTTP 402, payment not accepted); the buyer is charged nothing and nobody earns a second commission", again.status === 402 && d2.b === 0 && d2.d === 0 && d2.m === 0 && d2.f === 0, `${fmt(d2)}; http ${again.status}`);
  rec("replay through the gateway: no second sale is created (still the one settled sale)", (await saleStatus(sale)) === "settled");
  evidence.push(`replay: second use x402 payment ${tx(again.tx)} (events: ${gw.events.filter((e) => e.type !== "facilitator").map((e) => e.type + ((e as any).reason ? ":" + (e as any).reason : "")).slice(-4).join(", ")})`);
  await gw.close();

  // straight at the program: open the same sale a second time
  const control = PublicKey.findProgramAddressSync([Buffer.from("control"), campaign.toBuffer()], PROGRAM)[0];
  const msg = Buffer.from(claim.message);
  const openIx = await program.methods.openSale([...claim.nonce], new anchor.BN(claim.expiry), new anchor.BN(PRICE.toString())).accounts({
    payer: buyer.publicKey, campaign, distributor: distributor.publicKey, buyer: buyer.publicKey, mint: USDC, sale, saleVault: ata(sale),
    instructions: new PublicKey("Sysvar1nstructions1111111111111111111111111"), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, control } as any).instruction();
  let replayErr = "";
  try { await sendAndConfirmTransaction(conn, new Transaction().add(Ed25519Program.createInstructionWithPrivateKey({ privateKey: attest.secretKey, message: msg }), openIx), [buyer]); }
  catch (e: any) { replayErr = String(e?.message ?? e) + " " + (e?.logs ?? e?.transactionLogs ?? []).join(" "); }
  rec("replay straight at the program: open_sale with the same claim FAILS (the sale account already exists)", replayErr !== "" && /already in use|already been processed/i.test(replayErr), replayErr.replace(/\s+/g, " ").slice(0, 140));
}

// =========================== 2. REFUND INSIDE THE HOLD ===========================
console.log("\n== 2. A refund inside the hold ==");
{
  const campaign = await newCampaign(1_000_000_000n, 120);
  evidence.push(`campaign (refund): ${campaign.toBase58()}`);
  const gw = await startGateway(campaign, false); // the merchant does not settle: the sale stays open through the hold
  const claim = await mkClaim(campaign); const sale = salePda(PROGRAM, campaign, claim.nonce);
  const b0 = await snap(); const paid = await call(gw.url, claimToWire(claim)); await sleep(2500);
  let vault = 0; for (let i = 0; i < 12 && !vault; i++) { vault = await bal(ata(sale)); if (!vault) await sleep(1500); }
  const b1 = await snap();
  rec("the buyer's payment is held in the per-sale vault, the sale is open", paid.status === 200 && vault === Number(PRICE) && (await saleStatus(sale)) === "open", `vault ${vault}; ${fmt(delta(b0, b1))}`);
  evidence.push(`refund: x402 payment into the vault ${tx(paid.tx)}`);
  const refundSig = await chain.refund(claim); await sleep(2500); const b2 = await snap();
  rec("the merchant refunds inside the hold: the buyer gets the WHOLE payment back; distributor and protocol get nothing", (await saleStatus(sale)) === "refunded" && b2.b - b1.b === Number(PRICE) && b2.d === b1.d && b2.f === b1.f && b2.m === b1.m, fmt(delta(b1, b2)));
  evidence.push(`refund: refund_sale ${tx(refundSig)}`);
  let settleErr = "";
  try { await chain.settle(claim); } catch (e: any) { settleErr = String(e?.message ?? e) + " " + (e?.logs ?? []).join(" "); }
  rec("a refunded sale can no longer be settled", settleErr !== "", settleErr.replace(/\s+/g, " ").slice(0, 120));
  await gw.close();
}

// =========================== 3. EXHAUSTED BUDGET ===========================
console.log("\n== 3. An exhausted commission budget ==");
{
  const campaign = await newCampaign(10_000n, 15); // a 0.01 USDC commission budget; a full 15% commission on a 0.10 sale would be 0.015
  evidence.push(`campaign (budget): ${campaign.toBase58()}`);
  const gw = await startGateway(campaign, true);
  const c1 = await mkClaim(campaign); const s1 = salePda(PROGRAM, campaign, c1.nonce);
  let a = await snap(); const r1 = await call(gw.url, claimToWire(c1)); const st1 = await waitStatus(s1, "settled"); await sleep(1500); let b = await snap(); const d1 = delta(a, b);
  rec("sale 1: the commission is CAPPED at the remaining budget (0.010000 of the 0.015 owed); the merchant keeps the rest", r1.status === 200 && st1 === "settled" && d1.d === 10_000 && d1.f === FEE && d1.m === Number(PRICE) - FEE - 10_000, fmt(d1));
  evidence.push(`budget: sale 1 x402 payment ${tx(r1.tx)}`);
  const c2 = await mkClaim(campaign); const s2 = salePda(PROGRAM, campaign, c2.nonce);
  a = await snap(); const r2 = await call(gw.url, claimToWire(c2)); const st2 = await waitStatus(s2, "settled"); await sleep(1500); b = await snap(); const d2 = delta(a, b);
  rec("sale 2 (budget now empty): the buyer STILL pays and is served; commission is 0; merchant keeps all but the protocol fee", r2.status === 200 && r2.body.includes("served") && st2 === "settled" && d2.d === 0 && d2.f === FEE && d2.m === Number(PRICE) - FEE, fmt(d2));
  evidence.push(`budget: sale 2 x402 payment ${tx(r2.tx)}`);
  const camp: any = await (program.account as any).campaign.fetch(campaign);
  const total = BigInt((camp.commissionBudget ?? camp.commission_budget).toString()), spent = BigInt((camp.commissionSpent ?? camp.commission_spent).toString());
  rec("on-chain: budget 0.010000, spent 0.010000 (remaining 0)", total === 10_000n && spent === 10_000n, `total ${total}, spent ${spent}`);
  await gw.close();
}

console.log("\n--- evidence (explorer links) ---\n" + evidence.join("\n"));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
