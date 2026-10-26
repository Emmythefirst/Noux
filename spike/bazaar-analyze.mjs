import fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
const items = JSON.parse(fs.readFileSync(process.argv[2]));
const key = new URL(process.env.RPC_URL).searchParams.get("api-key");
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(fn, tries = 6) { for (let i = 0; i < tries; i++) { try { const v = await fn(); await sleep(300); return v; } catch (e) { if (!/429|fetch failed/.test(e.message)) throw e; await sleep(1500 * (i + 1)); } } throw new Error("rate-limited/unreachable after retries"); }
const MAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const sellers = new Map();
for (const it of items) for (const a of it.accepts ?? []) {
  if (a.network !== MAIN && a.network !== "solana") continue;
  if (!a.payTo || !a.asset) continue;
  const k = a.payTo + "|" + a.asset;
  const s = sellers.get(k) ?? { payTo: a.payTo, asset: a.asset, hosts: new Set(), n: 0, ex: it.description?.slice(0, 90), prices: [] };
  s.hosts.add(new URL(it.resource).host); s.n++; s.prices.push(Number(a.amount ?? a.maxAmountRequired ?? 0)); sellers.set(k, s);
}
const ranked = [...sellers.values()].sort((a, b) => b.n - a.n).slice(0, Number(process.argv[3] ?? 45));
console.log("distinct solana-mainnet (payTo,asset) sellers in sample:", sellers.size, "| analysing top", ranked.length);
const rows = [];
for (const s of ranked) {
  try {
    const owner = new PublicKey(s.payTo), mint = new PublicKey(s.asset);
    const ata = getAssociatedTokenAddressSync(mint, owner, true);
    const sigs = await rpc(() => conn.getSignaturesForAddress(ata, { limit: 40 }));
    const ok = sigs.filter((x) => !x.err);
    const txs = []; for (const x of ok.slice(0, 20)) txs.push(await rpc(() => conn.getParsedTransaction(x.signature, { maxSupportedTransactionVersion: 0 })));
    const payers = new Map();
    for (const t of txs) {
      if (!t) continue;
      const ixs = [...t.transaction.message.instructions, ...(t.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
      for (const ix of ixs) {
        const p = ix.parsed; if (!p || !["transfer", "transferChecked"].includes(p.type)) continue;
        if (p.info.destination !== ata.toBase58()) continue;
        const who = p.info.authority ?? p.info.multisigAuthority; if (who) payers.set(who, (payers.get(who) ?? 0) + 1);
      }
    }
    const self = payers.has(s.payTo);
    const top = [...payers.values()].sort((a, b) => b - a)[0] ?? 0, tot = [...payers.values()].reduce((a, b) => a + b, 0);
    rows.push({ hosts: [...s.hosts].slice(0, 2).join(","), resources: s.n, ex: s.ex, recentTx: ok.length, newest: ok[0]?.blockTime ? new Date(ok[0].blockTime * 1000).toISOString().slice(0, 10) : "-", oldestOfSample: ok.at(-1)?.blockTime ? new Date(ok.at(-1).blockTime * 1000).toISOString().slice(0, 10) : "-", distinctPayers: payers.size, topPayerShare: tot ? +(top / tot).toFixed(2) : 0, selfPay: self, payTo: s.payTo });
  } catch (e) { rows.push({ hosts: [...s.hosts][0], err: e.message?.slice(0, 80) }); }
}
fs.writeFileSync(process.argv[4] ?? "bazaar-rows.json", JSON.stringify(rows, null, 1));
console.table(rows.map(({ ex, payTo, ...r }) => r));
