// Browser e2e (dev only): create with a FAILING listing step, recover with "List this campaign", edit, then "Remove from directory". Same setup notes as wallet-e2e.mjs. Last run: 11/11.
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

// ---- create a campaign but make the LISTING step fail (simulates a failure halfway) ----
await page.route("**/campaigns/*/listing", (r) => r.abort());
await page.goto("http://localhost:5173/app/merchant", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Connect", exact: true }).first().click();
await page.getByRole("button", { name: /Test Wallet/ }).click();
await page.getByText("No campaigns for this wallet").waitFor({ timeout: 40000 });
await page.getByRole("button", { name: "Create campaign" }).first().click();
await page.getByPlaceholder("Market brief").fill("Retry listing service");
await page.getByPlaceholder("What a buyer gets for one call").fill("Listed on the second try");
await page.getByPlaceholder("https://api.example.com/report").fill("https://example.com/retry");
await page.locator("#cc-budget").fill("3.00");
await page.getByRole("button", { name: /Create campaign · 3.00/ }).click();
await page.waitForSelector("text=publishing the listing failed", { timeout: 90000 }).catch(() => {});
const msg = (await page.getByRole("alert").allInnerTexts()).join(" | ");
rec("listing failure after a successful on-chain create tells the user how to recover", /created on-chain/.test(msg) && /List this campaign/.test(msg), msg.slice(0, 200));
await page.unroute("**/campaigns/*/listing");
// find the campaign on chain via the API index
let camp = null;
for (let i = 0; i < 20 && !camp; i++) { const l = await (await fetch("http://localhost:8787/v1/campaigns?includeUnlisted=1&limit=100")).json(); camp = l.items.find((c) => c.merchant === merchant.publicKey.toBase58()); if (!camp) await sleep(3000); }
rec("campaign exists on-chain and is UNLISTED (no listing)", !!camp && camp.listing === null, camp?.address);
rec("unlisted campaign is not in the public directory", !(await (await fetch("http://localhost:8787/v1/campaigns?limit=100")).json()).items.some((c) => c.address === camp.address));
// ---- campaign page: merchant sees the button, a stranger would not ----
await page.goto(`http://localhost:5173/campaigns/${camp.address}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
rec("page says the campaign is unlisted and warns promoters", await page.getByText(/Only promote it if you know and trust the merchant/).isVisible());
await page.getByRole("button", { name: "List this campaign" }).click();
await page.getByPlaceholder("Market brief").fill("Retry listing service");
await page.getByPlaceholder("What a buyer gets for one call").fill("Listed on the second try");
await page.getByPlaceholder("https://api.example.com/report").fill("https://example.com/retry");
await page.getByRole("button", { name: "Sign and publish" }).click();
await page.waitForSelector("text=Retry listing service", { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(2000);
const after = await (await fetch(`http://localhost:8787/v1/campaigns/${camp.address}`)).json();
rec("listing published by signing with the merchant wallet; API now has it", after.listing?.name === "Retry listing service" && after.listing.isSample === false, JSON.stringify(after.listing?.name));
rec("button now says Edit listing", await page.getByRole("button", { name: "Edit listing" }).isVisible());
// ---- edit ----
await page.getByRole("button", { name: "Edit listing" }).click();
await page.getByPlaceholder("Market brief").fill("Retry listing service v2");
await page.getByRole("button", { name: "Sign and update" }).click();
await page.waitForTimeout(6000);
const after2 = await (await fetch(`http://localhost:8787/v1/campaigns/${camp.address}`)).json();
rec("edit updates the listing in place", after2.listing?.name === "Retry listing service v2", after2.listing?.name);
// ---- remove from the directory ----
await page.getByRole("button", { name: "Edit listing" }).click();
await page.getByRole("button", { name: "Remove from directory" }).click();
await page.getByRole("button", { name: "Sign and remove" }).click();
await page.waitForTimeout(6000);
const gone = await (await fetch(`http://localhost:8787/v1/campaigns/${camp.address}`)).json();
rec("remove from directory: listing gone, campaign itself still there", gone.listing === null && gone.address === camp.address);
rec("and it is no longer in the public directory", !(await (await fetch("http://localhost:8787/v1/campaigns?limit=100")).json()).items.some((c) => c.address === camp.address));
rec("page offers 'List this campaign' again", await page.getByRole("button", { name: "List this campaign" }).isVisible());
rec("no uncaught page errors", errs.length === 0, errs.join(" | "));
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await b.close(); process.exit(results.every(Boolean) ? 0 : 1);
