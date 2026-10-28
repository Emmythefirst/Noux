// Dev-only browser check: a HELD receipt page refreshes itself (route-mocked: open for a while, then refunded). Needs playwright-core + a Chromium binary; run vite first. Last run: flips within one poll.
import { chromium } from "playwright-core";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const SALE = "3ks3vSemYmoQkJSQQPgv6qJHwAzDmE55rqcRZuL9ftdr";
const real = await (await fetch("https://noux-api.onrender.com/v1/receipts/" + SALE)).json();
const open = { ...real, status: "open", refunded: false, funded: true, vaultAmount: "10000", gross: "0", settledAt: null, holdUntil: new Date(Date.now() + 6000).toISOString(), split: { merchant: "0", distributor: "0", protocolFee: "0" }, links: { ...real.links, settlement: null, refund: null } };
let phase = "open", hits = 0;
const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1100, height: 900 } }); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.route(`**/v1/receipts/${SALE}`, (r) => { hits++; r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(phase === "open" ? open : real) }); });
await p.goto("http://localhost:5173/r/" + SALE, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(3000);
const held = await p.getByText(/Held ·/).first().isVisible().catch(() => false);
console.log("starts as Held with a countdown:", held);
await p.waitForTimeout(9000);                       // hold ends; still open server-side
console.log("after the hold, still open on the server -> 'Ready to settle':", await p.getByText("Ready to settle").first().isVisible().catch(() => false));
phase = "refunded";                                 // the merchant refunds; the server now reports it
const t0 = Date.now();
await p.getByText("Refunded", { exact: true }).first().waitFor({ timeout: 20000 }).then(() => console.log("flipped to Refunded by itself after", Math.round((Date.now() - t0) / 1000), "s, polls:", hits)).catch(() => console.log("DID NOT FLIP (polls:", hits + ")"));
console.log("no Held left:", (await p.getByText(/Held ·/).count()) === 0, "errors:", errs);
await b.close();
