/**
 * Checks a DEPLOYED claim-issuance API (default https://noux-api.onrender.com) end to end on devnet:
 * live claims, live rejections, and that the keeper running on the host settles a funded sale by itself.
 * Usage (from apps/api):  API_URL=https://noux-api.onrender.com pnpm live-check
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, transfer } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { idl, configPda, claimFromWire, claimIsSelfConsistent, signClaimRequest, salePda, type ClaimWire } from "@noux/core";
import { AnchorChain } from "@noux/gateway";

process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
const API = (process.env.API_URL ?? "https://noux-api.onrender.com").replace(/\/$/, "");
const ROOT = path.resolve(import.meta.dirname, "../../..");
const load = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
const buyer = load(path.join(os.homedir(), ".config/solana/id.json"));
const merchant = load(path.join(ROOT, "spike/keys/merchant.json")), distributor = load(path.join(ROOT, "spike/keys/distributor.json"));
const oldAttest = load(path.join(ROOT, "spike/keys/attribution.json"));
const newAttestPub = new PublicKey(fs.readFileSync(path.join(ROOT, ".secrets/pubkeys.txt"), "utf8").split("\n")[0].trim());
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PROGRAM = new PublicKey((idl as any).address);
const conn = new Connection(process.env.RPC_URL!, "confirmed");
// The protocol fee and fee wallet come from the on-chain config, never from the campaign creator.
const protocolCfg = await (new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" })).account as any).config.fetch(configPda(PROGRAM));
const feeOwner = { publicKey: protocolCfg.feeOwner as PublicKey };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: boolean[] = [];
const rec = (name: string, ok: boolean, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const ata = (o: PublicKey) => getAssociatedTokenAddressSync(USDC, o, true);
const bal = async (a: PublicKey) => { try { return Number((await getAccount(conn, a)).amount); } catch (e) { if (/could not find account|TokenAccountNotFound/i.test(String((e as Error).name + (e as Error).message))) return 0; throw e; } };

const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(buyer), { commitment: "confirmed" }));
async function newCampaign(attestKey: PublicKey, hold: number) {
  const id = new anchor.BN(crypto.randomBytes(6));
  const [campaign] = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROGRAM);
  await program.methods.createCampaign(id, 1500, new anchor.BN(1_000_000_000), attestKey, [...Buffer.from("devnet\0\0")], hold)
    .accounts({ merchant: merchant.publicKey, mint: USDC, config: configPda(PROGRAM), campaign, systemProgram: SystemProgram.programId }).signers([merchant]).rpc();
  return campaign;
}
type Req = { campaign: PublicKey; dist?: PublicKey; price?: bigint; ts?: number; signer?: Keypair; sigOver?: Partial<{ price: bigint }> };
async function claim(r: Req) {
  const price = r.price ?? 100_000n, ts = r.ts ?? Math.floor(Date.now() / 1000), dist = r.dist ?? distributor.publicKey, signer = r.signer ?? buyer;
  const sig = signClaimRequest(signer.secretKey, { campaign: r.campaign, distributor: dist, buyer: buyer.publicKey, price: r.sigOver?.price ?? price, ts });
  const res = await fetch(`${API}/v1/claims`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign: r.campaign.toBase58(), distributor: dist.toBase58(), buyer: buyer.publicKey.toBase58(), price: price.toString(), ts, buyerSignature: Buffer.from(sig).toString("base64") }) });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

// ---- A. service identity
const t0 = Date.now(); const h = await (await fetch(`${API}/healthz`)).json() as any;
rec("A. /healthz reports the fresh attribution key and devnet", h.ok === true && h.attributionKey === newAttestPub.toBase58() && h.cluster === "devnet", `${Date.now() - t0}ms key=${h.attributionKey}`);

// ---- B. demo campaign using the NEW key, hold 15s
for (const o of [merchant, distributor, feeOwner]) await getOrCreateAssociatedTokenAccount(conn, buyer, USDC, o.publicKey);
const campaign = await newCampaign(newAttestPub, 15);
console.log("demo campaign (new attribution key):", campaign.toBase58());

// ---- C. live claim
const ok = await claim({ campaign });
const w: ClaimWire | undefined = ok.body?.claim;
const c = w ? claimFromWire(w) : undefined;
rec("C. live API issues a claim (201), signature valid, bound to the buyer, signed by the new key",
  ok.status === 201 && !!c && claimIsSelfConsistent(c) && c.buyer.equals(buyer.publicKey) && c.attributionKey.equals(newAttestPub) && c.cluster === "devnet" && c.price === 100_000n,
  `status=${ok.status} expiry in ${c ? c.expiry - Math.floor(Date.now() / 1000) : "?"}s`);

// ---- D. live rejections
rec("D. request signed by someone other than the buyer -> 401", (await claim({ campaign, signer: Keypair.generate() })).status === 401);
rec("D. stale request (replay of an old signed request) -> 401", (await claim({ campaign, ts: Math.floor(Date.now() / 1000) - 300 })).status === 401);
rec("D. price altered after signing -> 401", (await claim({ campaign, price: 1n, sigOver: { price: 100_000n } })).status === 401);
rec("D. self-referral (distributor == buyer) -> 400", (await claim({ campaign, dist: buyer.publicKey })).status === 400);
rec("D. price above the service limit -> 400", (await claim({ campaign, price: 1_000_000_000n })).status === 400);
rec("D. unknown campaign -> 404", (await claim({ campaign: Keypair.generate().publicKey })).status === 404);
const oldKeyCampaign = await newCampaign(oldAttest.publicKey, 15);
rec("D. campaign that trusts a DIFFERENT attribution key -> 404 (service refuses to sign for it)", (await claim({ campaign: oldKeyCampaign })).status === 404);
const junk = await fetch(`${API}/v1/claims`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
rec("D. malformed body -> 400", junk.status === 400);

// ---- E. the keeper running on the host settles a funded sale by itself
if (c) {
  const chain = new AnchorChain({ connection: conn, programId: PROGRAM, mint: USDC, gatewayPayer: buyer });
  const sale = await chain.ensureOpen(c);
  const want = salePda(PROGRAM, campaign, c.nonce);
  rec("E. sale opened on-chain from the live claim", sale.equals(want));
  const before = { m: await bal(ata(merchant.publicKey)), d: await bal(ata(distributor.publicKey)), f: await bal(ata(feeOwner.publicKey)) };
  await transfer(conn, buyer, ata(buyer.publicKey), ata(sale), buyer, 100_000); // buyer pays the vault (plain transfer; x402 path is covered elsewhere)
  console.log("vault funded; waiting for the hosted keeper (hold 15s + tick 10s)...");
  let settled = false; let status = "open";
  for (let i = 0; i < 40 && !settled; i++) { await sleep(3000); const s: any = await (program.account as any).sale.fetch(sale); status = Object.keys(s.status)[0]; settled = status === "settled"; }
  await sleep(2500);
  const after = { m: await bal(ata(merchant.publicKey)), d: await bal(ata(distributor.publicKey)), f: await bal(ata(feeOwner.publicKey)) };
  rec("E. hosted keeper settled the sale on its own (merchant never signed)", settled, `status=${status}`);
  rec("E. split is exact: 84000 / 15000 / 1000", after.m - before.m === 84000 && after.d - before.d === 15000 && after.f - before.f === 1000, `${after.m - before.m}/${after.d - before.d}/${after.f - before.f}`);
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
