/**
 * Squads v4 multisig rehearsal on DEVNET with a THROWAWAY clone of the program (the real program's authority is never touched).
 *   DEVNET=1 pnpm tsx scripts/multisig-rehearsal.ts
 * Proves: a 2-of-3 multisig vault can hold a program's upgrade authority, the old authority loses it, a program upgrade runs
 * through propose -> approve -> execute, the vault can sign an arbitrary instruction (what update_config needs), and the vault
 * can close the program to return the rent. Keys are saved to .secrets/ BEFORE any funds move.
 */
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY, LAMPORTS_PER_SOL, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
if (process.env.DEVNET !== "1") throw new Error("set DEVNET=1");
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const retryFetch: typeof fetch = async (u, i) => { for (let n = 0; ; n++) { try { return await fetch(u, i); } catch (e) { if (n >= 5) throw e; await new Promise((r) => setTimeout(r, 1000 * (n + 1))); } } };
const conn = new Connection(RPC, { commitment: "confirmed", fetch: retryFetch });
const root = path.resolve(import.meta.dirname, "../../..");
const so = path.join(root, "program/target/deploy/noux.so");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const dir = path.join(root, ".secrets/multisig-rehearsal"); fs.mkdirSync(dir, { recursive: true });
const load = (n: string) => { const f = path.join(dir, n + ".json"); if (fs.existsSync(f)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8")))); const k = Keypair.generate(); fs.writeFileSync(f, JSON.stringify([...k.secretKey]), { mode: 0o600 }); return k; };
const [m1, m2, m3, createKey, progKp] = ["m1", "m2", "m3", "createkey", "program"].map(load);
const keyFile = (n: string) => path.join(dir, n + ".json");
const sol = (...a: string[]) => execFileSync("solana", ["-u", RPC, "-k", keyFile("payer-link"), ...a], { encoding: "utf8" }).trim();
try { fs.symlinkSync(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, keyFile("payer-link")); } catch {}
const confirmed = async (p: Promise<string>) => { const sig = await p; const bh = await conn.getLatestBlockhash(); await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed"); return sig; };
const results: { name: string; ok: boolean }[] = [];
const rec = (name: string, ok: boolean, d = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${d ? "  -> " + d : ""}`); };
const PROG = progKp.publicKey;
const programData = PublicKey.findProgramAddressSync([PROG.toBuffer()], LOADER)[0];
const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
console.log("throwaway program", PROG.toBase58(), "multisig", multisigPda.toBase58(), "vault", vault.toBase58());
const authorityOf = () => /Authority: (\S+)/.exec(sol("program", "show", PROG.toBase58()))?.[1];
const lastSlot = () => Number(/Last Deployed In Slot: (\d+)/.exec(sol("program", "show", PROG.toBase58()))?.[1]);

// 1. fund members, create the 2-of-3 multisig
for (const m of [m1, m2, m3]) if ((await conn.getBalance(m.publicKey)) < 0.05 * LAMPORTS_PER_SOL)
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: m.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [payer]);
const treasury = (await multisig.accounts.ProgramConfig.fromAccountAddress(conn, multisig.getProgramConfigPda({})[0])).treasury;
if (!(await conn.getAccountInfo(multisigPda))) await confirmed(multisig.rpc.multisigCreateV2({ connection: conn, createKey, creator: payer, multisigPda, configAuthority: null, threshold: 2, timeLock: 0, rentCollector: null, treasury,
  members: [m1, m2, m3].map((m) => ({ key: m.publicKey, permissions: multisig.types.Permissions.all() })) }));
const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
rec("2-of-3 multisig created on devnet", ms.threshold === 2 && ms.members.length === 3, multisigPda.toBase58());

// 2. throwaway program, authority -> vault
if (!(await conn.getAccountInfo(PROG))) sol("program", "deploy", so, "--program-id", keyFile("program"));
rec("throwaway program deployed", !!(await conn.getAccountInfo(PROG)));
if (authorityOf() === payer.publicKey.toBase58()) sol("program", "set-upgrade-authority", PROG.toBase58(), "--new-upgrade-authority", vault.toBase58(), "--skip-new-upgrade-authority-signer-check");
rec("upgrade authority moved to the multisig vault", authorityOf() === vault.toBase58(), vault.toBase58());

// 3. the old authority must now be refused
let refused = false; // the deploy wallet tries to take the authority back: must be refused
try { sol("program", "set-upgrade-authority", PROG.toBase58(), "--new-upgrade-authority", payer.publicKey.toBase58(), "--skip-new-upgrade-authority-signer-check"); } catch (e: any) { refused = true; }
rec("deploy wallet can no longer change or use the upgrade authority (refused)", refused && authorityOf() === vault.toBase58());
const bufA = process.env.BUFFER ?? sol("program", "write-buffer", so).replace(/^Buffer: /, "");
console.log("buffer", bufA);
const slot0 = lastSlot();

// 4. upgrade through the multisig: buffer authority -> vault, then propose / approve x2 / execute
if (!process.env.BUFFER) sol("program", "set-buffer-authority", bufA, "--new-buffer-authority", vault.toBase58());
const upgradeIx = new TransactionInstruction({ programId: LOADER, data: Buffer.from([3, 0, 0, 0]), keys: [
  { pubkey: programData, isSigner: false, isWritable: true }, { pubkey: PROG, isSigner: false, isWritable: true },
  { pubkey: new PublicKey(bufA), isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: false, isWritable: true },
  { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
  { pubkey: vault, isSigner: false, isWritable: false } ] });
let txIndex = Number(ms.transactionIndex);
async function viaMultisig(label: string, ixs: TransactionInstruction[]) {
  txIndex += 1; const idx = BigInt(txIndex);
  const message = new TransactionMessage({ payerKey: vault, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: ixs });
  await confirmed(multisig.rpc.vaultTransactionCreate({ connection: conn, feePayer: payer, multisigPda, transactionIndex: idx, creator: m1.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message, signers: [payer, m1] }));
  await confirmed(multisig.rpc.proposalCreate({ connection: conn, feePayer: payer, multisigPda, transactionIndex: idx, creator: m1 }));
  await confirmed(multisig.rpc.proposalApprove({ connection: conn, feePayer: payer, multisigPda, transactionIndex: idx, member: m1 }));
  // one approval is below the threshold: execution must be refused
  let early = false;
  try { await confirmed(multisig.rpc.vaultTransactionExecute({ connection: conn, feePayer: payer, multisigPda, transactionIndex: idx, member: m1.publicKey, signers: [payer, m1] })); } catch { early = true; }
  rec(`${label}: 1 of 2 approvals cannot execute`, early);
  await confirmed(multisig.rpc.proposalApprove({ connection: conn, feePayer: payer, multisigPda, transactionIndex: idx, member: m2 }));
  await confirmed(multisig.rpc.vaultTransactionExecute({ connection: conn, feePayer: payer, multisigPda, transactionIndex: idx, member: m2.publicKey, signers: [payer, m2] }));
}
await viaMultisig("program upgrade", [upgradeIx]);
rec("upgrade executed through the multisig (deployed slot advanced)", lastSlot() > slot0, `${slot0} -> ${lastSlot()}`);
rec("authority is still the vault after the upgrade", authorityOf() === vault.toBase58());

// 5. the vault can sign an arbitrary instruction (the same mechanism update_config needs from a Signer)
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 0.01 * LAMPORTS_PER_SOL })), [payer]);
const dest = Keypair.generate().publicKey;
await viaMultisig("vault-signed instruction", [SystemProgram.transfer({ fromPubkey: vault, toPubkey: dest, lamports: 0.005 * LAMPORTS_PER_SOL })]);
rec("vault signed an instruction through the multisig", (await conn.getBalance(dest)) === 0.005 * LAMPORTS_PER_SOL);

// 6. close the program through the multisig to get the rent back (rehearses a second kind of proposal)
const before = await conn.getBalance(payer.publicKey);
const closeIx = new TransactionInstruction({ programId: LOADER, data: Buffer.from([5, 0, 0, 0]), keys: [
  { pubkey: programData, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: false, isWritable: true },
  { pubkey: vault, isSigner: false, isWritable: false }, { pubkey: PROG, isSigner: false, isWritable: true } ] });
await viaMultisig("close program", [closeIx]);
const gained = (await conn.getBalance(payer.publicKey)) - before;
rec("program closed through the multisig; rent returned to the deploy wallet", gained > 1.4 * LAMPORTS_PER_SOL, (gained / LAMPORTS_PER_SOL).toFixed(3) + " SOL");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
