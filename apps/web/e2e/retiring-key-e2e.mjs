// Dev-only browser check: a merchant whose campaign trusts a key the claim service is retiring gets a banner on the campaign page and a notice in the key dialog;
// without a retiring key, neither appears. The claim-service answer is intercepted; the wallet is a Wallet Standard mock; NO transaction is signed.
// Needs playwright-core + Chromium, vite on :5173 (live API), and MERCHANT_KEY_FILE (the demo merchant's key file).
import { chromium } from "playwright-core";
import { Keypair } from "@solana/web3.js";
import fs from "node:fs";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const merchant = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.MERCHANT_KEY_FILE, "utf8"))));
const CAMPAIGN = "GkNQ8DsSN1hiZFD7gv3KLJkmQHuEpyUrpeoKcmPyVjvt";
const campaign = await (await fetch(`https://noux-api.onrender.com/v1/campaigns/${CAMPAIGN}`)).json();
const results = []; const rec = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); };
const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
async function run(retiringKeys) {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } }); const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await ctx.addInitScript(({ pubkeyBytes, address }) => {
    const account = { address, publicKey: Uint8Array.from(pubkeyBytes), chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"] };
    const wallet = { version: "1.0.0", name: "Test Wallet", icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjwvc3ZnPg==", chains: ["solana:devnet"], accounts: [],
      features: { "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) }, "standard:disconnect": { version: "1.0.0", disconnect: async () => {} }, "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy"], signTransaction: async () => { throw new Error("this test never signs"); } }, "solana:signMessage": { version: "1.0.0", signMessage: async () => { throw new Error("this test never signs"); } } } };
    const reg = (api) => api.register(wallet); window.addEventListener("wallet-standard:app-ready", (e) => reg(e.detail)); window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: reg }));
  }, { pubkeyBytes: Array.from(merchant.publicKey.toBytes()), address: merchant.publicKey.toBase58() });
  await page.route(/\/v1\/claim-service/, async (route) => route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ attributionKey: "11111111111111111111111111111112", retiringKeys, cluster: "devnet", programId: "x", claimTtlSecs: 600 }) }));
  await page.goto(`http://localhost:5173/campaigns/${CAMPAIGN}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Connect", exact: true }).first().click({ timeout: 90000 }); await page.getByRole("button", { name: /Test Wallet/ }).click();
  await page.getByRole("button", { name: "Change claim key" }).first().waitFor({ timeout: 90000 });
  const banner = (await page.getByText(/Noux is retiring the claim key this campaign trusts/).count()) > 0;
  await page.getByRole("button", { name: "Change claim key" }).first().click(); await page.getByRole("dialog").waitFor();
  const notice = (await page.getByRole("dialog").getByText(/Noux is retiring the key this campaign trusts/).count()) > 0;
  await ctx.close(); return { banner, notice, errs };
}
const withRetiring = await run([campaign.attributionKey]);
rec("campaign trusts a retiring key: the merchant sees the banner on the campaign page", withRetiring.banner);
rec("...and the key dialog explains it", withRetiring.notice);
const without = await run([]);
rec("no retiring key: no banner, no notice", !without.banner && !without.notice);
const other = await run(["11111111111111111111111111111113"]);
rec("a retiring key that is NOT the campaign's: no banner", !other.banner && !other.notice);
rec("no page errors", [...withRetiring.errs, ...without.errs, ...other.errs].length === 0, [...withRetiring.errs].join(" | "));
await b.close(); console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
