/**
 * Service key rotation with an overlap, on REAL devnet. The claim service holds a NEW active key and an OLD retiring key; a campaign trusts the OLD one.
 *   1. the service issues a claim signed by the OLD key and the program accepts it (nothing stranded)
 *   2. a second claim is issued, UNUSED; the merchant then rotates the campaign to the NEW key
 *   3. the unused OLD-key claim is now rejected by the PROGRAM (keeping the old key in the service does not weaken a merchant's rotation)
 *   4. the service now signs with the NEW key for that campaign (no restart) and the program accepts it
 *   set -a; . ../../.env; set +a; NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000 pnpm tsx scripts/key-overlap-devnet.ts
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { configPda, LocalKeySigner, OnchainCampaignReader, idl, signClaimRequest, claimFromWire, type ClaimWire } from "@noux/core";
import { AnchorChain } from "@noux/gateway";
import { createPool, migrate } from "../src/db";
import { createApp } from "../src/app";

process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const [oldKey, newKey, merchant] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const conn = new Connection(process.env.RPC_URL!, "confirmed"), PROGRAM = new PublicKey((idl as any).address);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: boolean[] = []; const rec = (n: string, ok: boolean, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); };

await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: merchant.publicKey, lamports: 30_000_000 })), [deployer]);
const mint = await createMint(conn, deployer, deployer.publicKey, null, 6);
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(merchant), { commitment: "confirmed" }));
const cid = new anchor.BN(crypto.randomBytes(6)); const campaign = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), cid.toArrayLike(Buffer, "le", 8)], PROGRAM)[0];
await program.methods.createCampaign(cid, 1500, new anchor.BN(1_000_000), oldKey.publicKey, [...Buffer.from("devnet\0\0")], 0).accounts({ merchant: merchant.publicKey, mint, config: configPda(PROGRAM), campaign, systemProgram: SystemProgram.programId } as any).signers([merchant]).rpc();
console.log("campaign", campaign.toBase58(), "trusts the OLD key", oldKey.publicKey.toBase58().slice(0, 8));

const pool = createPool(process.env.DATABASE_URL_TEST ?? "postgres://postgres:devonly@localhost:54329/noux"); await migrate(pool); await pool.query("TRUNCATE claim_issuance");
const app = createApp({ pool, signer: new LocalKeySigner(newKey.secretKey), retiringSigners: [new LocalKeySigner(oldKey.secretKey)], campaigns: new OnchainCampaignReader(conn, PROGRAM, 1_000, 1_000),
  cfg: { CLUSTER: "devnet", PROGRAM_ID: PROGRAM.toBase58(), CLAIM_TTL_SECS: 600, MAX_PRICE_BASE_UNITS: 100_000_000n, LIMIT_PER_DISTRIBUTOR_PER_MIN: 1000, LIMIT_PER_BUYER_PER_MIN: 1000, LIMIT_PER_CAMPAIGN_PER_MIN: 1000, LIMIT_PER_IP_PER_MIN: 1000 } }, { trustProxy: true });
const claim = async (): Promise<ClaimWire> => { const b = Keypair.generate(), d = Keypair.generate().publicKey, ts = Math.floor(Date.now() / 1000), sig = signClaimRequest(b.secretKey, { campaign, distributor: d, buyer: b.publicKey, price: 10_000n, ts });
  const r = await app.request("/v1/claims", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.5" }, body: JSON.stringify({ campaign: campaign.toBase58(), distributor: d.toBase58(), buyer: b.publicKey.toBase58(), price: "10000", ts, buyerSignature: Buffer.from(sig).toString("base64") }) });
  if (r.status !== 201) throw new Error("claim " + r.status + " " + (await r.text())); return (await r.json() as any).claim; };
const chain = new AnchorChain({ connection: conn, programId: PROGRAM, mint, gatewayPayer: deployer });
const opens = async (w: ClaimWire) => { try { await chain.ensureOpen(claimFromWire(w)); return "opened"; } catch (e) { return String((e as Error).message) + " " + (((e as any).logs ?? []).join(" ")); } };

const c1 = await claim(); rec("the service signs a claim for the old-key campaign with the OLD key", claimFromWire(c1).attributionKey.equals(oldKey.publicKey));
rec("the program accepts that claim (open_sale on devnet)", (await opens(c1)) === "opened");
const c2 = await claim(); // issued under the old key, NOT used yet
await program.methods.setAttributionKey(newKey.publicKey).accounts({ merchant: merchant.publicKey, campaign } as any).signers([merchant]).rpc(); console.log("merchant rotated the campaign to the NEW key");
const r2 = await opens(c2);
rec("the unused OLD-key claim is now rejected by the PROGRAM (the overlap does not weaken a merchant's rotation)", /WrongSigner|not signed by the campaign attribution key/i.test(r2), r2.slice(0, 80));
await sleep(2500); // the campaign reader's cache (1 s here, 15 s in production)
const c3 = await claim(); rec("with no restart, the service now signs for that campaign with the NEW key", claimFromWire(c3).attributionKey.equals(newKey.publicKey));
rec("the program accepts the new-key claim", (await opens(c3)) === "opened");
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`); await pool.end(); process.exit(results.every(Boolean) ? 0 : 1);
