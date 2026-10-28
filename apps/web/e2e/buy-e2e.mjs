// Dev-only browser e2e of the human buyer flow against the LIVE devnet services: referred purchase (claim + wallet-signed x402 payment, receipt settles 84000/15000/1000 to the referrer), plain purchase, own-link warning. Needs playwright-core, tweetnacl, @solana/web3.js, @solana/spl-token, Chromium, RPC_URL, and a funded deploy wallet; run vite first.
import { chromium } from "playwright-core";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } from "@solana/spl-token";
import nacl from "tweetnacl";
import fs from "node:fs";

const RPC = process.env.RPC_URL, conn = new Connection(RPC, "confirmed");
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json"))));
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const CAMPAIGN = "GkNQ8DsSN1hiZFD7gv3KLJkmQHuEpyUrpeoKcmPyVjvt";
const buyer = Keypair.generate(), distributor = Keypair.generate();
const results = []; const rec = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); };

// fund the browser buyer: a little SOL (not needed for x402 fees, but for the ATA) and 0.3 devnet USDC
const bAta = getAssociatedTokenAddressSync(USDC, buyer.publicKey), dAta = getAssociatedTokenAddressSync(USDC, deployer.publicKey);
await sendAndConfirmTransaction(conn, new Transaction().add(
  SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: buyer.publicKey, lamports: 5_000_000 }),
  createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, bAta, buyer.publicKey, USDC),
  createTransferInstruction(dAta, bAta, deployer.publicKey, 300_000)), [deployer]);
console.log("buyer:", buyer.publicKey.toBase58(), "referrer:", distributor.publicKey.toBase58());

const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1100, height: 1000 } });
const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.exposeFunction("__signRaw", (bytes) => { const t = VersionedTransaction.deserialize(Uint8Array.from(bytes)); t.sign([buyer]); return Array.from(t.serialize()); });
await page.exposeFunction("__signMsg", (bytes) => Array.from(nacl.sign.detached(Uint8Array.from(bytes), buyer.secretKey)));
await ctx.addInitScript(({ pk, address }) => {
  const account = { address, publicKey: Uint8Array.from(pk), chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"] };
  const wallet = { version: "1.0.0", name: "Test Wallet", icon: "", chains: ["solana:devnet"], accounts: [], features: {
    "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) }, "standard:disconnect": { version: "1.0.0", disconnect: async () => {} }, "standard:events": { version: "1.0.0", on: () => () => {} },
    "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async (...ins) => Promise.all(ins.map(async (i) => ({ signedTransaction: Uint8Array.from(await window.__signRaw(Array.from(i.transaction))) }))) },
    "solana:signMessage": { version: "1.0.0", signMessage: async (...ins) => Promise.all(ins.map(async (i) => ({ signedMessage: i.message, signature: Uint8Array.from(await window.__signMsg(Array.from(i.message))) }))) } } };
  const reg = (api) => api.register(wallet);
  window.addEventListener("wallet-standard:app-ready", (e) => reg(e.detail)); window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: reg }));
}, { pk: Array.from(buyer.publicKey.toBytes()), address: buyer.publicKey.toBase58() });

await page.goto(`http://localhost:5173/buy/${CAMPAIGN}?ref=${distributor.publicKey.toBase58()}`, { waitUntil: "domcontentloaded" });
rec("price discovered from the service's 402 (waits for a cold start)", await page.getByText("0.100000").first().waitFor({ timeout: 90000 }).then(() => true).catch(() => false));
rec("page names the referrer and says the price is the same", (await page.locator("body").innerText()).includes(distributor.publicKey.toBase58().slice(0, 4) + "…") && /same with or without a referral/.test(await page.locator("body").innerText()));
await page.getByRole("button", { name: "Connect", exact: true }).first().click().catch(() => {});
await page.getByRole("button", { name: /Test Wallet/ }).click();
rec("wallet connects and the devnet USDC balance shows", await page.getByText(/devnet USDC balance 0\.3/).waitFor({ timeout: 30000 }).then(() => true).catch(() => false));
await page.getByRole("button", { name: /^Pay 0.100000 USDC/ }).click();
const paid = await page.getByText("Paid. Here is what you bought").waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
const alerts = (await page.getByRole("alert").allInnerTexts()).join(" | ");
rec("referred purchase: claim signed, payment signed by the wallet, resource received", paid, alerts);
let saleLink = null;
if (paid) { saleLink = await page.getByRole("link", { name: /View the receipt/ }).getAttribute("href"); rec("response body shows the sample data", /sample/i.test(await page.locator("pre").innerText())); }
// receipt through the live API
let rcpt = null; const sale = saleLink?.replace("/r/", "");
for (let i = 0; i < 30 && sale && !rcpt?.status?.match(/settled/); i++) { await new Promise((r) => setTimeout(r, 6000)); rcpt = await (await fetch("https://noux-api.onrender.com/v1/receipts/" + sale)).json().catch(() => null); }
rec("receipt settles on-chain with the exact split, credited to the referrer", rcpt?.status === "settled" && rcpt.split.merchant === "84000" && rcpt.split.distributor === "15000" && rcpt.split.protocolFee === "1000" && rcpt.parties.distributor === distributor.publicKey.toBase58() && rcpt.parties.buyer === buyer.publicKey.toBase58(), rcpt ? JSON.stringify(rcpt.split) : "no receipt");

// plain purchase
await page.goto(`http://localhost:5173/buy/${CAMPAIGN}`, { waitUntil: "domcontentloaded" });
await page.getByText("0.100000").first().waitFor({ timeout: 60000 });
rec("link without ref says no referral", await page.getByText(/No referral on this link/).isVisible());
await page.getByRole("button", { name: /^Pay 0.100000 USDC/ }).click();
rec("plain purchase works (merchant paid in full)", await page.getByText("Paid. Here is what you bought").waitFor({ timeout: 90000 }).then(() => true).catch(() => false));
// self referral
await page.goto(`http://localhost:5173/buy/${CAMPAIGN}?ref=${buyer.publicKey.toBase58()}`, { waitUntil: "domcontentloaded" });
await page.getByText(/This is your own referral link/).waitFor({ timeout: 60000 }).catch(() => {});
rec("own referral link: warned, only the plain purchase is offered", await page.getByText(/can’t refer yourself/).isVisible() && (await page.getByRole("button", { name: /Buy without the referral/ }).count()) === 0);
rec("no uncaught page errors", errs.length === 0, errs.join(" | "));
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await b.close(); process.exit(results.every(Boolean) ? 0 : 1);
