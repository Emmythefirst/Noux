// Spike step: will the x402.org facilitator settle a real devnet USDC payment into
// a token account whose OWNER is an off-curve (PDA) address? No Noux program needed.
import fs from "fs"; import os from "os"; import crypto from "crypto";
import express from "express";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAccount } from "@solana/spl-token";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactSvmScheme as ExactSvmClient } from "@x402/svm/exact/client";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { createKeyPairSignerFromBytes } from "@solana/kit";

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PROG = new PublicKey("AC6AtoRALLszNGNLmHte2UXKzCqBYQKhPdtq5qs77nkL");
const secret = Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + "/.config/solana/id.json")));
const payer = Keypair.fromSecretKey(secret);
const conn = new Connection(process.env.RPC_URL, "confirmed");

const [offOwner] = PublicKey.findProgramAddressSync([Buffer.from("offcurve-test"), crypto.randomBytes(8)], PROG);
console.log("off-curve owner:", offOwner.toBase58(), "isOnCurve =", PublicKey.isOnCurve(offOwner.toBytes()));
const ata = await getOrCreateAssociatedTokenAccount(conn, payer, USDC, offOwner, true);
console.log("vault ATA:", ata.address.toBase58());

const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const server = new x402ResourceServer(facilitator).register(NET, new ExactSvmScheme());
const app = express();
app.use(paymentMiddleware({
  "GET /paid": { accepts: [{ scheme: "exact", network: NET, payTo: offOwner.toBase58(), price: "$0.01" }], description: "offcurve test" },
}, server));
app.get("/paid", (_q, r) => r.json({ ok: true }));
const http = app.listen(4021);
await new Promise(r => setTimeout(r, 1500));

const raw = await fetch("http://localhost:4021/paid");
console.log("unpaid status:", raw.status);
const reqHdr = raw.headers.get("payment-required");
if (reqHdr) console.log("402 requirements:", Buffer.from(reqHdr, "base64").toString());

const signer = await createKeyPairSignerFromBytes(secret);
const client = new x402Client().register("solana:*", new ExactSvmClient(signer));
const paidFetch = wrapFetchWithPayment(fetch, client);
try {
  const res = await paidFetch("http://localhost:4021/paid");
  console.log("paid status:", res.status, await res.text());
  const h = res.headers.get("payment-response");
  if (h) console.log("settlement:", JSON.stringify(decodePaymentResponseHeader(h)));
} catch (e) { console.log("PAID FETCH ERROR:", e?.message ?? e, e?.cause ?? ""); }
const acc = await getAccount(conn, ata.address);
console.log("vault balance (base units):", acc.amount.toString());
http.close(); process.exit(0);
