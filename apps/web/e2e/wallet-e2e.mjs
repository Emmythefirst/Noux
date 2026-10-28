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
// a wrong wallet cannot refund: reuse the dialog with no wallet match is covered by program tests; here check page errors
rec("no uncaught page errors", errs.length === 0, errs.join(" | "));
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await b.close();
process.exit(results.every(Boolean) ? 0 : 1);
