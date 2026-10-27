/**
 * Protocol-fee enforcement, proven on a LOCAL validator (needs an upgradeable program so the upgrade-authority check is real).
 *   solana-test-validator --reset --ledger /tmp/noux-ledger --upgradeable-program <PROGRAM_ID> program/target/deploy/noux.so <AUTHORITY_PUBKEY>
 *   UPGRADE_AUTHORITY=/path/authority.json pnpm tsx scripts/fee-local.ts
 * Every "must fail" case asserts the specific program error, so a different failure cannot pass for the right one.
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
const [admin, admin2, feeWallet, feeWallet2, merchant, merchant2, distributor, buyer, attest, rando] = Array.from({ length: 10 }, () => Keypair.generate());
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(rando), { commitment: "confirmed" }));
const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM)[0];
const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
const results: { name: string; ok: boolean }[] = [];
const rec = (name: string, ok: boolean, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const errText = (e: any) => String(e?.message ?? e) + " " + (e?.logs ?? e?.transactionLogs ?? []).join(" ");

async function expectOk(name: string, f: () => Promise<unknown>) { try { await f(); rec(name, true); } catch (e) { rec(name, false, errText(e).slice(0, 300)); } }
async function expectErr(name: string, re: RegExp, f: () => Promise<unknown>) {
  try { await f(); rec(name, false, "succeeded but must fail"); } catch (e) { const t = errText(e); rec(name, re.test(t), re.test(t) ? "" : "wrong error: " + t.slice(0, 300)); }
}

const cfg = async () => (program.account as any).config.fetch(configPda);
const camp = async (a: PublicKey) => (program.account as any).campaign.fetch(a);
const cidBn = () => new anchor.BN(crypto.randomBytes(6));
const campaignPda = (m: PublicKey, id: anchor.BN) => PublicKey.findProgramAddressSync([Buffer.from("campaign"), m.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROGRAM)[0];
const clusterTag = [...Buffer.from("localnet")];

for (const k of [authority, admin, admin2, merchant, merchant2, rando, buyer, distributor]) await fund(k, k === authority ? 20 : 5);
const mint = await createMint(conn, authority, authority.publicKey, null, 6);

const initConfig = (signer: Keypair, a: PublicKey, f: PublicKey, bps: number) =>
  program.methods.initConfig(a, f, bps).accounts({ authority: signer.publicKey, config: configPda, programData, systemProgram: SystemProgram.programId } as any).signers([signer]).rpc();
const updateConfig = (signer: Keypair, a: PublicKey, f: PublicKey, bps: number) =>
  program.methods.updateConfig(a, f, bps).accounts({ admin: signer.publicKey, config: configPda } as any).signers([signer]).rpc();
const createCampaign = (m: Keypair, id: anchor.BN, commissionBps: number, budget = 1_000_000_000, cfgAcct: PublicKey = configPda) =>
  program.methods.createCampaign(id, commissionBps, new anchor.BN(budget), attest.publicKey, clusterTag, 15)
    .accounts({ merchant: m.publicKey, mint, config: cfgAcct, campaign: campaignPda(m.publicKey, id), systemProgram: SystemProgram.programId } as any).signers([m]).rpc();

// ---- the instruction no longer accepts a creator-chosen fee or fee wallet ----
const ccIx = (idl as any).instructions.find((i: any) => i.name === "create_campaign");
rec("create_campaign has no fee_bps / fee_owner argument or account", !ccIx.args.some((a: any) => /fee/.test(a.name)) && !ccIx.accounts.some((a: any) => /fee/.test(a.name)));

// ---- init_config ----
await expectErr("init_config by a wallet that is not the upgrade authority is rejected", /NotUpgradeAuthority|not the program upgrade authority/i, () => initConfig(rando, admin.publicKey, feeWallet.publicKey, 100));
await expectErr("init_config with fee above the 5% cap is rejected", /BpsTooHigh|bps out of range/i, () => initConfig(authority, admin.publicKey, feeWallet.publicKey, 501));
await expectOk("init_config by the upgrade authority (fee 1%, separate admin, separate fee wallet)", () => initConfig(authority, admin.publicKey, feeWallet.publicKey, 100));
{ const c = await cfg(); rec("config holds the admin, fee wallet and fee", c.admin.equals(admin.publicKey) && c.feeOwner.equals(feeWallet.publicKey) && c.feeBps === 100 && !c.admin.equals(authority.publicKey)); }
await expectErr("init_config cannot be run twice", /already in use|custom program error: 0x0/i, () => initConfig(authority, admin2.publicKey, feeWallet2.publicKey, 0));

// ---- create_campaign takes the fee from config only ----
const lookalike = Keypair.generate();
await expectErr("create_campaign with a look-alike config account is rejected", /ConstraintSeeds|seeds constraint|AccountNotInitialized|not initialized/i, () => createCampaign(merchant, cidBn(), 1500, 1_000_000_000, lookalike.publicKey));
const idA = cidBn(), campA = campaignPda(merchant.publicKey, idA);
await expectOk("create_campaign (merchant) succeeds", () => createCampaign(merchant, idA, 1500));
{ const c = await camp(campA); rec("campaign.fee_bps and fee_owner equal the config's, not anything the merchant chose", c.feeBps === 100 && c.feeOwner.equals(feeWallet.publicKey), `fee ${c.feeBps}`); }
await expectErr("commission + fee above 100% is still rejected", /BpsTooHigh|bps out of range/i, () => createCampaign(merchant, cidBn(), 5001)); // 5001 > MAX_COMMISSION_BPS

// ---- update_config ----
await expectErr("update_config by the merchant is rejected", /NotAdmin|not the config admin/i, () => updateConfig(merchant, merchant.publicKey, merchant.publicKey, 0));
await expectErr("update_config by the upgrade authority (not the admin) is rejected", /NotAdmin|not the config admin/i, () => updateConfig(authority, authority.publicKey, authority.publicKey, 0));
await expectErr("update_config above the 5% cap is rejected even for the admin", /BpsTooHigh|bps out of range/i, () => updateConfig(admin, admin.publicKey, feeWallet.publicKey, 501));
await expectOk("admin updates the fee to 2.5% and the fee wallet", () => updateConfig(admin, admin.publicKey, feeWallet2.publicKey, 250));
{ const c = await camp(campA); rec("existing campaign is untouched by the config change (still 1%, old fee wallet)", c.feeBps === 100 && c.feeOwner.equals(feeWallet.publicKey)); }
const idB = cidBn(), campB = campaignPda(merchant2.publicKey, idB);
await expectOk("a campaign created after the change", () => createCampaign(merchant2, idB, 1500));
{ const c = await camp(campB); rec("new campaign copies the NEW fee and wallet", c.feeBps === 250 && c.feeOwner.equals(feeWallet2.publicKey)); }
await expectOk("admin rotation to a new admin key", () => updateConfig(admin, admin2.publicKey, feeWallet2.publicKey, 250));
await expectErr("the old admin can no longer update after rotation", /NotAdmin|not the config admin/i, () => updateConfig(admin, admin.publicKey, feeWallet.publicKey, 0));

// ---- a full sale on the NEW campaign: fee goes to the config's wallet and the split still sums exactly ----
const gross = 100_000n;
const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint, o, true);
await getOrCreateAssociatedTokenAccount(conn, authority, mint, buyer.publicKey);
await getOrCreateAssociatedTokenAccount(conn, authority, mint, merchant2.publicKey);
await mintTo(conn, authority, mint, ata(buyer.publicKey), authority, 1_000_000);
const nonce = crypto.randomBytes(32), expiry = Math.floor(Date.now() / 1000) + 600;
const msg = buildClaimMessage({ programId: PROGRAM, cluster: "localnet", campaign: campB, distributor: distributor.publicKey, buyer: buyer.publicKey, expiry, price: gross, nonce });
const edIx = Ed25519Program.createInstructionWithPrivateKey({ privateKey: attest.secretKey, message: msg });
const sale = salePda(PROGRAM, campB, nonce);
const openIx = await program.methods.openSale([...nonce], new anchor.BN(expiry), new anchor.BN(gross.toString()))
  .accounts({ payer: rando.publicKey, campaign: campB, distributor: distributor.publicKey, buyer: buyer.publicKey, mint, sale, saleVault: ata(sale), instructions: new PublicKey("Sysvar1nstructions1111111111111111111111111"), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as any).instruction();
await sendAndConfirmTransaction(conn, new Transaction().add(edIx, openIx), [rando]);
await transfer(conn, buyer, ata(buyer.publicKey), ata(sale), buyer, gross);
const bal = async (o: PublicKey) => { try { return (await getAccount(conn, ata(o))).amount; } catch { return 0n; } };
const before = { f1: await bal(feeWallet.publicKey), f2: await bal(feeWallet2.publicKey), m: await bal(merchant2.publicKey), d: await bal(distributor.publicKey) };
const pre = [merchant2.publicKey, distributor.publicKey, feeWallet2.publicKey].map((o) => createAssociatedTokenAccountIdempotentInstruction(merchant2.publicKey, ata(o), o, mint));
const settleIx = await program.methods.settleSale().accounts({ caller: merchant2.publicKey, campaign: campB, sale, saleVault: ata(sale), merchantAta: ata(merchant2.publicKey), distributorAta: ata(distributor.publicKey), feeAta: ata(feeWallet2.publicKey), rentPayer: rando.publicKey, tokenProgram: TOKEN_PROGRAM_ID } as any).instruction();
await expectOk("settle the sale (merchant)", () => sendAndConfirmTransaction(conn, new Transaction().add(...pre, settleIx), [merchant2]));
const after = { f1: await bal(feeWallet.publicKey), f2: await bal(feeWallet2.publicKey), m: await bal(merchant2.publicKey), d: await bal(distributor.publicKey) };
const fee = after.f2 - before.f2, comm = after.d - before.d, mer = after.m - before.m;
rec("fee paid to the config's wallet = floor(gross * 2.5%)", fee === (gross * 250n) / 10000n && after.f1 === before.f1, `fee ${fee}`);
rec("commission = floor(gross * 15%) and merchant gets the remainder; parts sum to gross exactly", comm === 15_000n && mer + comm + fee === gross, `${mer}+${comm}+${fee}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
