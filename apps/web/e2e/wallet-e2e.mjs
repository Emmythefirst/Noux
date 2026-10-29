// Browser wallet end-to-end (dev only, not in CI). Drives the REAL UI with a Wallet Standard mock wallet that signs with a local keypair, against devnet.
// Needs: a local API (apps/api, INDEXER_INTERVAL_SECONDS=5, ATTRIBUTION_KEY_FILE=.secrets/render-attribution.json), `VITE_API_URL=http://localhost:8787/v1 vite`,
// playwright-core + tweetnacl + @solana/web3.js + @solana/spl-token installed next to this file, a Chromium binary, RPC_URL in the env, and the deploy wallet funded (SOL + devnet USDC).
// Paths below are this developer machine's; adjust. Last run: 14/14 (see progress.md).
import { chromium } from "playwright-core";
import nacl from "tweetnacl";
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, Ed25519Program } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, transfer, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import crypto from "node:crypto";

const RPC = process.env.RPC_URL, conn = new Connection(RPC, "confirmed");
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json"))));
const attest = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/home/emmanuel/Axia/.secrets/render-attribution.json"))));
const merchant = Keypair.generate();
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PROGRAM = new PublicKey("AC6AtoRALLszNGNLmHte2UXKzCqBYQKhPdtq5qs77nkL");
const FEE_WALLET = "D7BRCmMDeCVqwPnBMgvsCPmDHLptcZwHsnyjiXjKXRYf";
const results = []; const rec = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ata = (o) => getAssociatedTokenAddressSync(USDC, o, true);

await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: merchant.publicKey, lamports: 30_000_000 })), [deployer]);
console.log("merchant (browser wallet):", merchant.publicKey.toBase58());

const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
// the "wallet": a Wallet Standard wallet whose signing happens in node with a real keypair
await page.exposeFunction("__signTx", (bytes) => { const t = Transaction.from(Buffer.from(bytes)); t.partialSign(merchant); return Array.from(t.serialize({ requireAllSignatures: false })); });
await page.exposeFunction("__signMsg", (bytes) => Array.from(nacl.sign.detached(Uint8Array.from(bytes), merchant.secretKey)));
await ctx.addInitScript(({ pubkeyBytes, address }) => {
  const account = { address, publicKey: Uint8Array.from(pubkeyBytes), chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"] };
  const wallet = {
    version: "1.0.0", name: "Test Wallet", icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IiMwRjc2NkUiLz48L3N2Zz4=",
    chains: ["solana:devnet"], accounts: [], 
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy"], signTransaction: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedTransaction: Uint8Array.from(await window.__signTx(Array.from(i.transaction))) }))) },
      "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: Uint8Array.from(await window.__signMsg(Array.from(i.message))) }))) },
    },
  };
  const reg = (api) => api.register(wallet);
  window.addEventListener("wallet-standard:app-ready", (e) => reg(e.detail));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: reg }));
}, { pubkeyBytes: Array.from(merchant.publicKey.toBytes()), address: merchant.publicKey.toBase58() });

// ---- connect ----
await page.goto("http://localhost:5173/app/merchant", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Connect", exact: true }).first().click();
await page.getByRole("button", { name: /Test Wallet/ }).click();
await page.waitForSelector(`text=${merchant.publicKey.toBase58().slice(0, 4)}…`, { timeout: 10000 }).catch(() => {});
rec("wallet connects through the modal and the address shows", (await page.locator("body").innerText()).includes(merchant.publicKey.toBase58().slice(0, 4) + "…" + merchant.publicKey.toBase58().slice(-4)));
await page.screenshot({ path: "shots/merchant-connected.png" });
rec("merchant page defaults to the connected wallet (empty state for a brand-new wallet)", await page.getByText("No campaigns for this wallet").waitFor({ timeout: 40000 }).then(() => true).catch(() => false));

// ---- create campaign ----
await page.getByRole("button", { name: "Create campaign" }).first().click();
await page.getByPlaceholder("Market brief").fill("E2E test service");
await page.getByPlaceholder("What a buyer gets for one call").fill("Created by the browser end-to-end test");
await page.getByPlaceholder("https://api.example.com/report").fill("https://example.com/e2e");
await page.locator("#cc-budget").fill("12.50");
await page.getByRole("button", { name: /Create campaign · 12.50/ }).click();
await page.waitForSelector("text=Campaign created and listed", { timeout: 90000 }).catch(() => {});
const toast = await page.getByText("Campaign created and listed").isVisible().catch(() => false);
const alert = await page.getByRole("alert").allInnerTexts().catch(() => []);
rec("create campaign: wallet approved tx + listing message, API accepted the listing", toast, alert.join(" | "));

// ---- verify on chain + API ----
const list = await (await fetch("http://localhost:8787/v1/campaigns?includeUnlisted=1&limit=100")).json();
await sleep(1000);
let camp = null;
for (let i = 0; i < 20 && !camp; i++) { const l = await (await fetch("http://localhost:8787/v1/campaigns?limit=100")).json(); camp = l.items.find((c) => c.merchant === merchant.publicKey.toBase58()); if (!camp) await sleep(3000); }
rec("campaign is in the public directory with the merchant-signed listing", !!camp && camp.listing?.name === "E2E test service" && camp.listing.isSample === false, camp?.address);
rec("on-chain terms: commission 15%, hold 120 s, budget 12.50 USDC cap", camp && camp.commissionBps === 1500 && camp.holdSecs === 120 && camp.budget.total === "12500000", camp ? JSON.stringify({ c: camp.commissionBps, h: camp.holdSecs, b: camp.budget.total }) : "");
rec("fee is the PROTOCOL's: 1% to the config's fee wallet (the form never asked for it)", camp && camp.feeBps === 100 && camp.feeOwner === FEE_WALLET && camp.feeEnforced === true, camp ? `${camp.feeBps} ${camp.feeOwner} enforced=${camp.feeEnforced}` : "");

// ---- open + fund a sale out-of-band, then refund it from the UI ----
import { execFileSync } from "node:child_process";
const out = execFileSync("npx", ["tsx", "scripts/open-funded-sale.ts", camp.address, "10000"], { cwd: "/home/emmanuel/Axia/apps/api", env: { ...process.env, ATTRIBUTION_KEY_FILE: "/home/emmanuel/Axia/.secrets/render-attribution.json" }, encoding: "utf8" });
const { sale, buyer, vault } = JSON.parse(out.trim().split("\n").pop());
console.log("funded sale:", sale);
const buyerBefore = (await getAccount(conn, ata(new PublicKey(buyer)))).amount;
await page.goto("http://localhost:5173/app/merchant", { waitUntil: "domcontentloaded" });
let row = null;
for (let i = 0; i < 12 && !row; i++) { await page.waitForTimeout(5000); await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForTimeout(4000); if (await page.getByText(sale.slice(0, 4) + "…" + sale.slice(-4)).first().isVisible().catch(() => false)) row = true; }
rec("the funded sale appears in the merchant's table as Held", !!row);
for (let i = 0; i < 12 && !(await page.getByRole("button", { name: "Refund", exact: true }).count()); i++) { await page.waitForTimeout(5000); await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForTimeout(4000); }
rec("the funded sale offers a Refund action (index saw the vault balance)", (await page.getByRole("button", { name: "Refund", exact: true }).count()) > 0);
await page.getByRole("button", { name: "Refund", exact: true }).first().click();
await page.getByRole("alertdialog").getByRole("button", { name: "Refund sale" }).click();
await page.waitForSelector("text=Sale refunded", { timeout: 90000 }).catch(() => {});
// the row must flip to Refunded by itself: no page reload (the bug seen on the live site: it stayed "Held" with its countdown)
const flipped = await page.locator("tbody").getByText("Refunded", { exact: true }).first().waitFor({ timeout: 60000 }).then(() => true).catch(() => false);
rec("sales table shows Refunded without a reload (not Held)", flipped && (await page.locator("tbody").getByText(/Held/).count()) === 0);
rec("refund: wallet approved, toast shown", await page.getByText("Sale refunded").isVisible().catch(() => false), (await page.getByRole("alert").allInnerTexts().catch(() => [])).join(" | "));
await sleep(2000);
const acc = await conn.getAccountInfo(new PublicKey(sale), "confirmed");
rec("on-chain: sale status is Refunded", acc && acc.data[244] === 2, acc ? "status byte " + acc.data[244] : "no account");
const buyerAfter = (await getAccount(conn, ata(new PublicKey(buyer)))).amount;
rec("on-chain: buyer got the 10000 base units back", buyerAfter - buyerBefore === 10000n, String(buyerAfter - buyerBefore));
const vaultInfo = await conn.getAccountInfo(new PublicKey(vault), "confirmed");
rec("on-chain: vault closed, no commission or fee paid", vaultInfo === null);
// ---- campaign controls: Add budget and Change claim key (the new merchant-only instructions), from the real UI ----
const readCampaign = async () => { const i = await conn.getAccountInfo(new PublicKey(camp.address), "confirmed"); return { budget: i.data.readBigUInt64LE(172), spent: i.data.readBigUInt64LE(180), key: new PublicKey(i.data.slice(104, 136)).toBase58() }; };
const before = await readCampaign();
await page.goto(`http://localhost:5173/campaigns/${camp.address}`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Add budget" }).first().waitFor({ timeout: 90000 }).catch(() => {});
rec("campaign page offers Add budget and Change claim key to the merchant wallet", (await page.getByRole("button", { name: "Add budget" }).count()) > 0 && (await page.getByRole("button", { name: "Change claim key" }).count()) > 0);
await page.getByRole("button", { name: "Add budget" }).first().click();
const dlg = page.getByRole("dialog");
await dlg.locator("input").fill("2.50");
rec("the dialog previews the new cap before signing", /12\.50.*15\.00/.test(await dlg.innerText()), (await dlg.innerText()).replace(/\s+/g, " ").slice(0, 160));
await dlg.getByRole("button", { name: "Add budget" }).click();
await page.waitForSelector("text=Budget raised", { timeout: 90000 }).catch(() => {});
rec("add budget: wallet approved, confirmation shown", await page.getByText(/Budget raised by 2.50 USDC/).isVisible().catch(() => false), (await page.getByRole("alert").allInnerTexts().catch(() => [])).join(" | "));
await sleep(2000); const afterTop = await readCampaign();
rec("on-chain: the cap rose by exactly 2.50 USDC and what was spent is untouched", afterTop.budget === before.budget + 2_500_000n && afterTop.spent === before.spent, `${before.budget} -> ${afterTop.budget}`);
await page.getByRole("button", { name: "Change claim key" }).first().click();
const kd = page.getByRole("dialog");
await kd.locator("input").waitFor({ timeout: 30000 });
await page.waitForFunction(() => document.querySelector('[role="dialog"] input')?.value?.length > 30, null, { timeout: 30000 }).catch(() => {});
rec("the key dialog pre-fills the Noux claim key, and refuses it because the campaign already trusts it", /already trusts/i.test(await kd.innerText()) && (await kd.getByRole("button", { name: "Change key" }).isDisabled()));
const newKey = Keypair.generate().publicKey.toBase58();
await kd.locator("input").fill(newKey);
await kd.getByRole("button", { name: "Change key" }).click();
await page.waitForSelector("text=Claim key changed", { timeout: 90000 }).catch(() => {});
rec("change claim key: wallet approved, confirmation shown", await page.getByText(/Claim key changed/).isVisible().catch(() => false), (await page.getByRole("alert").allInnerTexts().catch(() => [])).join(" | "));
await sleep(2000); const afterKey = await readCampaign();
rec("on-chain: the campaign now trusts the new key, and the cap is unchanged", afterKey.key === newKey && afterKey.budget === afterTop.budget, `${before.key.slice(0, 6)} -> ${afterKey.key.slice(0, 6)}`);
// ---- pause / resume / end from the real UI ----
const CONTROL = PublicKey.findProgramAddressSync([Buffer.from("control"), new PublicKey(camp.address).toBuffer()], PROGRAM)[0];
const ctlState = async () => { const i = await conn.getAccountInfo(CONTROL, "confirmed"); return i ? ["active", "paused", "ended"][i.data[40]] : null; };
rec("before any pause the campaign has no control account (it is active)", (await ctlState()) === null);
await page.reload({ waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Pause promotions" }).first().waitFor({ timeout: 90000 }).catch(() => {});
rec("an active campaign offers Pause promotions and End campaign (not Resume)", (await page.getByRole("button", { name: "Pause promotions" }).count()) > 0 && (await page.getByRole("button", { name: "End campaign" }).count()) > 0 && (await page.getByRole("button", { name: "Resume promotions" }).count()) === 0);
await page.getByRole("button", { name: "Pause promotions" }).first().click();
{ const t = await page.getByRole("dialog").innerText(); rec("the pause dialog explains that buyers can still buy and open sales still settle", /can still buy from you without a referral/i.test(t) && /already open settle normally/i.test(t)); }
await page.getByRole("dialog").getByRole("button", { name: "Pause promotions" }).click();
await page.waitForSelector("text=Promotions paused", { timeout: 90000 }).catch(() => {});
rec("pause: wallet approved, confirmation shown", await page.getByText(/Promotions paused/).isVisible().catch(() => false), (await page.getByRole("alert").allInnerTexts().catch(() => [])).join(" | "));
await sleep(2000); rec("on-chain: the control account now says Paused", (await ctlState()) === "paused");
rec("the page shows the Paused badge and banner at once, and now offers Resume", (await page.getByText("Paused", { exact: true }).count()) > 0 && /paused promotions/i.test(await page.locator("body").innerText()) && (await page.getByRole("button", { name: "Resume promotions" }).count()) > 0 && (await page.getByRole("button", { name: "Pause promotions" }).count()) === 0);
await page.getByRole("button", { name: "Resume promotions" }).first().click();
await page.getByRole("dialog").getByRole("button", { name: "Resume promotions" }).click();
await page.waitForSelector("text=Promotions resumed", { timeout: 90000 }).catch(() => {});
await sleep(2000); rec("resume: on-chain state is Active again", (await ctlState()) === "active");
await page.getByRole("button", { name: "End campaign" }).first().click();
const endBtn = page.getByRole("dialog").getByRole("button", { name: "End campaign for good" });
rec("ending needs a typed confirmation: the button is disabled until END is typed", await endBtn.isDisabled());
await page.getByRole("dialog").locator("input").fill("end");
rec("...and enabled once END is typed", await endBtn.isEnabled());
await endBtn.click();
await page.waitForSelector("text=Campaign ended", { timeout: 90000 }).catch(() => {});
await sleep(2000); rec("end: on-chain state is Ended", (await ctlState()) === "ended");
rec("an ended campaign offers no pause, resume or end any more", (await page.getByRole("button", { name: /Pause promotions|Resume promotions|End campaign/ }).count()) === 0 && /has ended/i.test(await page.locator("body").innerText()));
rec("an ended campaign can still be topped up from the UI (harmless, and allowed on-chain)", (await page.getByRole("button", { name: "Add budget" }).count()) > 0);
// a wrong wallet cannot refund: reuse the dialog with no wallet match is covered by program tests; here check page errors
rec("no uncaught page errors", errs.length === 0, errs.join(" | "));
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await b.close();
process.exit(results.every(Boolean) ? 0 : 1);
