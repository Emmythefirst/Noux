/**
 * One-time protocol setup: create the global config (protocol fee % and fee wallet) and the fee wallet's token account.
 * Must be signed by the program's UPGRADE AUTHORITY. The admin and fee wallet are public keys only: keep their secret keys
 * somewhere else (not the deploy wallet, not the keeper payer).
 *   RPC_URL=... UPGRADE_AUTHORITY=~/.config/solana/id.json ADMIN=<pubkey> FEE_WALLET=<pubkey> FEE_BPS=100 MINT=<usdc mint> pnpm tsx scripts/init-config.ts
 */
import fs from "node:fs"; import os from "node:os";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { configPda, idl } from "@noux/core";

const need = (k: string) => process.env[k] ?? (() => { throw new Error(`set ${k}`); })();
const PROGRAM = new PublicKey((idl as any).address);
const conn = new Connection(need("RPC_URL"), "confirmed");
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.UPGRADE_AUTHORITY ?? `${os.homedir()}/.config/solana/id.json`, "utf8"))));
const admin = new PublicKey(need("ADMIN")), feeWallet = new PublicKey(need("FEE_WALLET")), mint = new PublicKey(need("MINT"));
const feeBps = Number(process.env.FEE_BPS ?? "100");
if (admin.equals(authority.publicKey) || feeWallet.equals(authority.publicKey)) throw new Error("use a separate admin and fee wallet: neither may be the deploy/upgrade wallet");

const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(authority), { commitment: "confirmed" }));
const cfgAddr = configPda(PROGRAM);
const existing = await conn.getAccountInfo(cfgAddr);
if (existing) {
  console.log("config already exists:", cfgAddr.toBase58(), JSON.stringify(await (program.account as any).config.fetch(cfgAddr), (_, v) => (v?.toBase58 ? v.toBase58() : v)));
} else {
  const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
  const sig = await program.methods.initConfig(admin, feeWallet, feeBps)
    .accounts({ authority: authority.publicKey, config: cfgAddr, programData, systemProgram: SystemProgram.programId } as any).rpc();
  console.log("config created:", cfgAddr.toBase58(), "tx", sig);
}
// Settlement transfers the fee to this token account; create it once, up front.
const fa = await getOrCreateAssociatedTokenAccount(conn, authority, mint, feeWallet);
console.log("fee wallet:", feeWallet.toBase58(), " fee token account:", fa.address.toBase58(), " fee_bps:", feeBps, " admin:", admin.toBase58());
process.exit(0);
