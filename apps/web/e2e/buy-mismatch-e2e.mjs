// Dev-only browser check: if the service's 402 asks for more than its listing says (or another token), the buy page shows why and does not allow payment.
// Needs playwright-core + Chromium, vite running on :5173. No wallet and no funds are involved: the page must refuse BEFORE a wallet is needed.
import { chromium } from "playwright-core";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const CAMPAIGN = process.env.CAMPAIGN ?? "GkNQ8DsSN1hiZFD7gv3KLJkmQHuEpyUrpeoKcmPyVjvt";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const results = []; const rec = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); };
async function scenario(name, accept, expectText) {
  const p = await (await b.newContext({ viewport: { width: 1100, height: 900 } })).newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.route(/noux-demo-merchant\.onrender\.com\/sample\/brief/, async (route) => {
    const body = { x402Version: 2, accepts: [{ scheme: "exact", network: NET, payTo: "11111111111111111111111111111111", ...accept }], resource: { url: "https://noux-demo-merchant.onrender.com/sample/brief" } };
    await route.fulfill({ status: 402, headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "payment-required", "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"), "content-type": "application/json" }, body: "{}" });
  });
  await p.goto(`http://localhost:5173/buy/${CAMPAIGN}`, { waitUntil: "domcontentloaded" });
  const alert = p.locator('[role="alert"]').filter({ hasText: expectText || /./ });
  if (expectText) { await alert.first().waitFor({ timeout: 90000 }).catch(() => {}); rec(`${name}: warning shown`, await alert.count() > 0, (await alert.first().textContent().catch(() => ""))?.slice(0, 110)); }
  else { await p.waitForTimeout(6000); rec(`${name}: no warning`, (await p.locator('[role="alert"]').count()) === 0); }
  const disabled = await p.getByRole("button", { name: /^Pay |Buy without/ }).evaluateAll((els) => els.every((e) => e.disabled)).catch(() => true);
  rec(`${name}: payment buttons are not usable`, expectText ? disabled : true);
  rec(`${name}: no page errors`, errs.length === 0, errs[0] ?? ""); await p.context().close();
}
await scenario("price inflated to 5 USDC (listing says $0.03-$0.10)", { amount: "5000000", asset: MINT }, /listing says/);
await scenario("another token than the campaign's", { amount: "100000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, /different token/);
await scenario("honest answer (0.10 USDC, campaign token)", { amount: "100000", asset: MINT }, null);
await b.close(); const bad = results.filter((x) => !x).length; console.log(`\n${results.length - bad}/${results.length} checks passed`); process.exit(bad ? 1 : 0);
