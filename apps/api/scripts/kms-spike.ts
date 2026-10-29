/**
 * KMS Ed25519 spike: does a cloud KMS produce signatures Solana's ed25519 verification accepts, over a real 197-byte Noux claim message?
 * The decisive check is the LAST one: a claim signed by the KMS key opens a sale on devnet, i.e. the program's own ed25519 precompile accepts it.
 *
 *   AWS (real):  cd apps/api && pnpm add -D @aws-sdk/client-kms     # the script does not depend on it until you run it
 *                set -a; . ../../.env; set +a
 *                AWS_REGION=eu-west-1 AWS_KMS_KEY_ID=<key id or arn> pnpm tsx scripts/kms-spike.ts
 *   Dry run (no cloud; a local key plays the KMS, to prove the script's own mechanics):   KMS_FAKE=1 pnpm tsx scripts/kms-spike.ts
 *   Skip the devnet step:  SKIP_DEVNET=1
 * Create the AWS key (spec name is exact):  aws kms create-key --key-spec ECC_NIST_EDWARDS25519 --key-usage SIGN_VERIFY --description "noux claim signing (spike)"
 * Least-privilege policy for the identity that signs: kms:Sign and kms:GetPublicKey on that one key ARN, nothing else.
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { buildClaimMessage, configPda, idl, signClaim, claimIsSelfConsistent, type ClaimSigner } from "@noux/core";
import { AnchorChain } from "@noux/gateway";

const FAKE = !!process.env.KMS_FAKE;
// Ed25519 straight from Node's crypto (OpenSSL): an implementation independent of the libraries Noux itself uses
const verifyEd25519 = (message: Uint8Array, signature: Uint8Array, pub32: Uint8Array) => { try { return crypto.verify(null, message, crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub32)]), format: "der", type: "spki" }), signature); } catch { return false; } };
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex"); // DER SubjectPublicKeyInfo header for an Ed25519 key, followed by the 32 raw bytes
const results: boolean[] = []; const rec = (n: string, ok: boolean, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); };
const info = (m: string) => console.log("      " + m);
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0;

/** What the spike needs from a KMS. */
interface Kms { describe(): Promise<{ keySpec: string; algorithms: string[]; publicKeyDer: Uint8Array }>; signRaw(message: Uint8Array): Promise<Uint8Array>; }

async function awsKms(): Promise<Kms> {
  const mod: any = await import("@aws-sdk/client-kms").catch(() => { throw new Error("install the SDK first:  cd apps/api && pnpm add -D @aws-sdk/client-kms"); });
  const keyId = process.env.AWS_KMS_KEY_ID; if (!keyId) throw new Error("set AWS_KMS_KEY_ID (key id or ARN)");
  const client = new mod.KMSClient({ region: process.env.AWS_REGION });
  return {
    describe: async () => { const r = await client.send(new mod.GetPublicKeyCommand({ KeyId: keyId })); return { keySpec: r.KeySpec, algorithms: r.SigningAlgorithms ?? [], publicKeyDer: r.PublicKey }; },
    // pure Ed25519 over the RAW message (the program verifies the signature over exactly these bytes)
    signRaw: async (message) => { const r = await client.send(new mod.SignCommand({ KeyId: keyId, Message: message, MessageType: "RAW", SigningAlgorithm: "ED25519_SHA_512" })); return new Uint8Array(r.Signature); },
  };
}
function fakeKms(): Kms { // a local key that behaves like the KMS API, including the DER public key format
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { describe: async () => ({ keySpec: "ECC_NIST_EDWARDS25519", algorithms: ["ED25519_SHA_512", "ED25519_PH_SHA_512"], publicKeyDer: publicKey.export({ format: "der", type: "spki" }) }), signRaw: async (m) => crypto.sign(null, m, privateKey) };
}

/** A ClaimSigner backed by a KMS: the shape the production signer would have. It re-verifies every signature locally, so a wrongly configured key can never ship a claim the program would reject. */
class KmsClaimSigner implements ClaimSigner {
  private constructor(readonly publicKey: PublicKey, private kms: Kms) {}
  static async create(kms: Kms) {
    const d = await kms.describe();
    if (d.keySpec !== "ECC_NIST_EDWARDS25519") throw new Error(`key spec is ${d.keySpec}, expected ECC_NIST_EDWARDS25519`);
    if (!d.algorithms.includes("ED25519_SHA_512")) throw new Error("the key does not offer ED25519_SHA_512 (pure Ed25519)");
    const der = Buffer.from(d.publicKeyDer);
    if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_ED25519_PREFIX)) throw new Error("public key is not a 32-byte Ed25519 SubjectPublicKeyInfo");
    return new KmsClaimSigner(new PublicKey(der.subarray(12)), kms);
  }
  async sign(message: Uint8Array) {
    const sig = await this.kms.signRaw(message);
    if (!verifyEd25519(message, sig, this.publicKey.toBytes())) throw new Error("the KMS returned a signature that is not a valid pure Ed25519 signature for its own public key");
    return sig;
  }
}

console.log(FAKE ? "DRY RUN: a local key stands in for the KMS (proves the script, not a provider)\n" : `AWS KMS, region ${process.env.AWS_REGION ?? "(default)"}\n`);
const kms = FAKE ? fakeKms() : await awsKms();
const d = await kms.describe();
rec("the key is an Ed25519 key (ECC_NIST_EDWARDS25519) that offers pure ED25519_SHA_512", d.keySpec === "ECC_NIST_EDWARDS25519" && d.algorithms.includes("ED25519_SHA_512"), `${d.keySpec} ${d.algorithms.join(",")}`);
const signer = await KmsClaimSigner.create(kms);
rec("the public key is a 32-byte Ed25519 key and parses to a Solana address", signer.publicKey.toBytes().length === 32, signer.publicKey.toBase58());

const params = { programId: new PublicKey((idl as any).address), cluster: "devnet", campaign: Keypair.generate().publicKey, distributor: Keypair.generate().publicKey, buyer: Keypair.generate().publicKey, expiry: Math.floor(Date.now() / 1000) + 600, price: 10_000n, nonce: crypto.randomBytes(32) };
const msg = buildClaimMessage(params);
rec("a real Noux claim message is 197 bytes (far below the KMS 4096-byte message limit)", msg.length === 197 && msg.length <= 4096, `${msg.length} bytes`);
const sig = await signer.sign(msg);
rec("the KMS signature verifies as standard Ed25519 over the raw message (what Solana's precompile checks)", verifyEd25519(msg, sig, signer.publicKey.toBytes()) && sig.length === 64);
const sig2 = await signer.sign(msg); rec("signing is deterministic (same message, same signature: a property of pure Ed25519)", Buffer.from(sig).equals(Buffer.from(sig2)));
const claim = await signClaim(signer, params as any); rec("a claim signed through the KMS signer is self-consistent (the same check the gateway runs)", claimIsSelfConsistent(claim));
rec("changing one byte of the message invalidates the signature", !verifyEd25519(Uint8Array.from([...msg.slice(0, 196), msg[196] ^ 1]), sig, signer.publicKey.toBytes()));

const seq: number[] = []; for (let i = 0; i < 20; i++) { const t = Date.now(); await signer.sign(crypto.randomBytes(197)); seq.push(Date.now() - t); }
const par = Date.now(); await Promise.all(Array.from({ length: 20 }, () => signer.sign(crypto.randomBytes(197)))); const parMs = Date.now() - par;
info(`latency (sequential x20): p50 ${pct(seq, .5)} ms, p95 ${pct(seq, .95)} ms, max ${Math.max(...seq)} ms; 20 in parallel: ${parMs} ms total`);

if (!process.env.SKIP_DEVNET) {
  // ---- the decisive check: Solana's own verification ----
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
  const conn = new Connection(process.env.RPC_URL!, "confirmed"), PROGRAM = new PublicKey((idl as any).address), merchant = Keypair.generate();
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: merchant.publicKey, lamports: 30_000_000 })), [deployer]);
  const mint = await createMint(conn, deployer, deployer.publicKey, null, 6);
  const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(merchant), { commitment: "confirmed" }));
  const cid = new anchor.BN(crypto.randomBytes(6)), campaign = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), cid.toArrayLike(Buffer, "le", 8)], PROGRAM)[0];
  await program.methods.createCampaign(cid, 1500, new anchor.BN(1_000_000), signer.publicKey, [...Buffer.from("devnet\0\0")], 0).accounts({ merchant: merchant.publicKey, mint, config: configPda(PROGRAM), campaign, systemProgram: SystemProgram.programId } as any).signers([merchant]).rpc();
  info(`devnet campaign ${campaign.toBase58()} trusts the KMS key ${signer.publicKey.toBase58()}`);
  const chain = new AnchorChain({ connection: conn, programId: PROGRAM, mint, gatewayPayer: deployer });
  const real = await signClaim(signer, { ...params, campaign, buyer: Keypair.generate().publicKey } as any);
  let verdict = "opened"; try { await chain.ensureOpen(real as any); } catch (e) { verdict = String((e as Error).message) + " " + (((e as any).logs ?? []).join(" ")); }
  rec("DECISIVE: a claim signed by the KMS key OPENS A SALE ON DEVNET (the program's ed25519 precompile accepts the KMS signature)", verdict === "opened", verdict === "opened" ? "" : verdict.slice(0, 160));
  const otherKey = crypto.generateKeyPairSync("ed25519").privateKey; const forged = await signClaim({ publicKey: signer.publicKey, sign: async (m: Uint8Array) => crypto.sign(null, m, otherKey) } as ClaimSigner, { ...params, campaign, buyer: Keypair.generate().publicKey, nonce: crypto.randomBytes(32) /* a NEW nonce: the real claim's sale already exists, which would short-circuit the open */ } as any).catch(() => null);
  if (forged) { let v2 = "opened"; try { await chain.ensureOpen(forged as any); } catch (e) { v2 = String((e as Error).message) + " " + (((e as any).logs ?? []).join(" ")); } rec("control: a claim carrying the same public key but a signature from another key is REJECTED on-chain", v2 !== "opened", v2.slice(0, 80)); }
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed${FAKE ? " (dry run: this proves the script, not a cloud provider)" : ""}`); process.exit(results.every(Boolean) ? 0 : 1);
