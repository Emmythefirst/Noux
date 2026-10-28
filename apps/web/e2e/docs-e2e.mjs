// Dev-only browser check of the docs site: search (Ctrl+K), previous/next, in-page links without reload, anchors, /docs redirect, unknown slug. Needs playwright-core + Chromium; run vite first. Last run: all pass, no console errors.
import { chromium } from "playwright-core";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const slugs = ["overview","quickstart","how-a-sale-works","gateway","campaigns-and-budgets","refunds-and-the-hold","keeper","referral-links","agents-and-claims","read-api","claims-api","on-chain-program","security-model","status","changelog"];
const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } }); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 120)));
// search
await p.goto("http://localhost:5173/docs/overview", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(500);
await p.keyboard.press("Control+k"); await p.waitForTimeout(400); await p.keyboard.type("refund"); await p.waitForTimeout(400);
console.log("search results shown:", await p.locator("[role=option]").count());
await p.keyboard.press("Enter"); await p.waitForTimeout(600);
console.log("search -> opened:", p.url());
// prev / next
await p.getByRole("link", { name: /Next/ }).click(); await p.waitForTimeout(400); console.log("next ->", p.url());
await p.getByRole("link", { name: /Previous/ }).click(); await p.waitForTimeout(400); console.log("previous ->", p.url());
// internal link in markdown (overview -> Security model) navigates without reload
await p.goto("http://localhost:5173/docs/overview", { waitUntil: "domcontentloaded" }); await p.evaluate(() => (window.__mark = 1));
await p.locator(".doc a", { hasText: "Security model" }).first().click(); await p.waitForTimeout(500);
console.log("md link ->", p.url(), "| no full reload:", await p.evaluate(() => window.__mark === 1));
// TOC anchor
await p.goto("http://localhost:5173/docs/security-model#browser-and-wallet", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(800);
console.log("anchor scrolled:", await p.evaluate(() => Math.round(document.getElementById("browser-and-wallet")?.getBoundingClientRect().top ?? -1)) < 200);
await p.goto("http://localhost:5173/docs", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(500); console.log("/docs ->", p.url());
await p.goto("http://localhost:5173/docs/nope", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(500); console.log("unknown slug:", await p.getByText("Page not found").isVisible());
console.log("errors:", errs);
await b.close();
