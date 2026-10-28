/**
 * settle_sale edge cases on a LOCAL validator: roles that share a wallet, and arithmetic extremes.
 *   solana-test-validator --reset --ledger /tmp/noux-ledger-edge --upgradeable-program <PROGRAM_ID> program/target/deploy/noux.so <AUTHORITY_PUBKEY>
 *   UPGRADE_AUTHORITY=/path/authority.json pnpm tsx scripts/settle-edge-local.ts
 * Every "must fail" case asserts the specific program error.
 */
import fs from "node:fs"; import crypto from "node:crypto";
import { Connection, Ed25519Program, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, mintTo, transfer, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { buildClaimMessage, idl, salePda } from "@noux/core";

const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const PROGRAM = new PublicKey((idl as any).address);
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.UPGRADE_AUTHORITY!, "utf8"))));
const fund = async (k: Keypair, sol = 5) => { await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, sol * 1e9), "confirmed"); };
const admin = Keypair.generate(), rando = Keypair.generate(), attest = Keypair.generate();
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(rando), { commitment: "confirmed" }));
const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM)[0];
const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
const results: { name: string; ok: boolean }[] = [];
const rec = (name: string, ok: boolean, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const errText = (e: any) => String(e?.message ?? e) + " " + (e?.logs ?? e?.transactionLogs ?? []).join(" ");
const clusterTag = [...Buffer.from("localnet")];
const ata = (mint: PublicKey, o: PublicKey) => getAssociatedTokenAddressSync(mint, o, true);

for (const k of [authority, admin, rando]) await fund(k, 20);
await program.methods.initConfig(admin.publicKey, admin.publicKey, 100)
  .accounts({ authority: authority.publicKey, config: configPda, programData, systemProgram: SystemProgram.programId } as any).signers([authority]).rpc();

interface Sc { name: string; commissionBps: number; budget: bigint; amount: bigint; price?: bigint; feeBps?: number;
  sameWallet?: "merchant=distributor" | "fee=merchant" | "fee=distributor" | "fee=merchant=distributor";
  expect: { merchant: bigint; commission: bigint; fee: bigint } | RegExp }

async function scenario(s: Sc) {
  const mint = await createMint(conn, authority, authority.publicKey, null, 6);
  const [merchant, buyer, other] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  for (const k of [merchant, buyer, other]) await fund(k, 3);
  const sw = s.sameWallet ?? "";
  const distributor = sw.includes("merchant=distributor") || sw === "fee=merchant=distributor" ? merchant : sw === "fee=distributor" ? other : Keypair.generate();
  const feeOwner = sw === "fee=merchant" || sw === "fee=merchant=distributor" ? merchant : sw === "fee=distributor" ? distributor : Keypair.generate();
  await program.methods.updateConfig(admin.publicKey, feeOwner.publicKey, s.feeBps ?? 100).accounts({ admin: admin.publicKey, config: configPda } as any).signers([admin]).rpc();
  const id = new anchor.BN(crypto.randomBytes(6));
  const campaign = PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROGRAM)[0];
  await program.methods.createCampaign(id, s.commissionBps, new anchor.BN(s.budget.toString()), attest.publicKey, clusterTag, 0)
    .accounts({ merchant: merchant.publicKey, mint, config: configPda, campaign, systemProgram: SystemProgram.programId } as any).signers([merchant]).rpc();
  await getOrCreateAssociatedTokenAccount(conn, authority, mint, buyer.publicKey);
  await mintTo(conn, authority, mint, ata(mint, buyer.publicKey), authority, s.amount);
  const nonce = crypto.randomBytes(32), expiry = Math.floor(Date.now() / 1000) + 600, price = s.price ?? s.amount;
  const msg = buildClaimMessage({ programId: PROGRAM, cluster: "localnet", campaign, distributor: distributor.publicKey, buyer: buyer.publicKey, expiry, price, nonce });
  const sale = salePda(PROGRAM, campaign, nonce);
  const openIx = await program.methods.openSale([...nonce], new anchor.BN(expiry), new anchor.BN(price.toString()))
    .accounts({ payer: rando.publicKey, campaign, distributor: distributor.publicKey, buyer: buyer.publicKey, mint, sale, saleVault: ata(mint, sale), instructions: new PublicKey("Sysvar1nstructions1111111111111111111111111"), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as any).instruction();
  await sendAndConfirmTransaction(conn, new Transaction().add(Ed25519Program.createInstructionWithPrivateKey({ privateKey: attest.secretKey, message: msg }), openIx), [rando]);
  await transfer(conn, buyer, ata(mint, buyer.publicKey), ata(mint, sale), buyer, s.amount);
  const roles = [merchant.publicKey, distributor.publicKey, feeOwner.publicKey];
  const pre = [...new Set(roles.map((r) => r.toBase58()))].map((r) => createAssociatedTokenAccountIdempotentInstruction(merchant.publicKey, ata(mint, new PublicKey(r)), new PublicKey(r), mint));
  const bal = async (o: PublicKey) => { try { return (await getAccount(conn, ata(mint, o))).amount; } catch { return 0n; } };
  const settleIx = await program.methods.settleSale().accounts({ caller: merchant.publicKey, campaign, sale, saleVault: ata(mint, sale), merchantAta: ata(mint, merchant.publicKey), distributorAta: ata(mint, distributor.publicKey), feeAta: ata(mint, feeOwner.publicKey), rentPayer: rando.publicKey, tokenProgram: TOKEN_PROGRAM_ID } as any).instruction();
  try {
    await sendAndConfirmTransaction(conn, new Transaction().add(...pre, settleIx), [merchant]);
  } catch (e) {
    if (s.expect instanceof RegExp) { const t = errText(e); return rec(s.name, s.expect.test(t), s.expect.test(t) ? "" : "wrong error: " + t.slice(0, 300)); }
    return rec(s.name, false, "settle failed: " + errText(e).replace(/\s+/g, " ").slice(0, 260));
  }
  if (s.expect instanceof RegExp) return rec(s.name, false, "settled but must fail");
  const sa = await (program.account as any).sale.fetch(sale);
  const got = { merchant: BigInt(sa.merchantAmount.toString()), commission: BigInt(sa.commissionAmount.toString()), fee: BigInt(sa.feeAmount.toString()) };
  const sum = got.merchant + got.commission + got.fee;
  // wallets that hold several roles must have received the sum of those roles; nothing may be left in the vault or lost
  const total = (await Promise.all([...new Set(roles.map((r) => r.toBase58()))].map((r) => bal(new PublicKey(r))))).reduce((a, b) => a + b, 0n);
  const ok = got.merchant === s.expect.merchant && got.commission === s.expect.commission && got.fee === s.expect.fee && sum === s.amount && total === s.amount;
  rec(s.name, ok, `${got.merchant}/${got.commission}/${got.fee} sum ${sum} received ${total}`);
}

// control: distinct wallets
await scenario({ name: "control: distinct wallets, 100000 at 15%+1% => 84000/15000/1000", commissionBps: 1500, budget: 1_000_000n, amount: 100_000n, expect: { merchant: 84_000n, commission: 15_000n, fee: 1_000n } });
// roles sharing a wallet (the merchant referring its own sale from the SAME wallet is not blocked by open_sale)
await scenario({ name: "merchant is also the distributor (same wallet) settles", commissionBps: 1500, budget: 1_000_000n, amount: 100_000n, sameWallet: "merchant=distributor", expect: { merchant: 84_000n, commission: 15_000n, fee: 1_000n } });
await scenario({ name: "protocol fee wallet is also the merchant settles", commissionBps: 1500, budget: 1_000_000n, amount: 100_000n, sameWallet: "fee=merchant", expect: { merchant: 84_000n, commission: 15_000n, fee: 1_000n } });
await scenario({ name: "protocol fee wallet is also the distributor settles", commissionBps: 1500, budget: 1_000_000n, amount: 100_000n, sameWallet: "fee=distributor", expect: { merchant: 84_000n, commission: 15_000n, fee: 1_000n } });
await scenario({ name: "merchant = distributor = fee wallet settles", commissionBps: 1500, budget: 1_000_000n, amount: 100_000n, sameWallet: "fee=merchant=distributor", expect: { merchant: 84_000n, commission: 15_000n, fee: 1_000n } });
// arithmetic extremes
await scenario({ name: "price 1 base unit: fee 0, commission 0, merchant keeps 1", commissionBps: 1500, budget: 1_000_000n, amount: 1n, expect: { merchant: 1n, commission: 0n, fee: 0n } });
await scenario({ name: "9999 units (rounding): fee 99, commission 1499, merchant 8401", commissionBps: 1500, budget: 1_000_000n, amount: 9_999n, expect: { merchant: 8_401n, commission: 1_499n, fee: 99n } });
await scenario({ name: "zero budget: commission 0, merchant keeps all but the fee", commissionBps: 1500, budget: 0n, amount: 100_000n, expect: { merchant: 99_000n, commission: 0n, fee: 1_000n } });
await scenario({ name: "budget 1 unit: commission capped at 1", commissionBps: 1500, budget: 1n, amount: 100_000n, expect: { merchant: 98_999n, commission: 1n, fee: 1_000n } });
await scenario({ name: "max commission 50% + max fee 5% => 45/50/5", commissionBps: 5000, budget: (1n << 64n) - 1n, amount: 100_000n, feeBps: 500, expect: { merchant: 45_000n, commission: 50_000n, fee: 5_000n } });
{
  const MAX = (1n << 64n) - 1n, fee = (MAX * 100n) / 10_000n, commission = (MAX * 1500n) / 10_000n;
  await scenario({ name: "u64::MAX payment does not overflow (u128 math)", commissionBps: 1500, budget: MAX, amount: MAX, feeBps: 100, expect: { merchant: MAX - fee - commission, commission, fee } });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
