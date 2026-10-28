// The human buyer flow: price discovery -> buyer-signed claim request -> claim -> x402 payment signed by the buyer's wallet.
// Everything here runs in the browser; the wallet signs, nothing secret ever leaves it. Loaded lazily (it pulls in the x402 client and @solana/kit).
import { API_BASE } from "./api";
import { RPC_URL } from "./verify";

export const referralLink = (campaign: string, wallet: string) => `${window.location.origin}/buy/${campaign}?ref=${wallet}`;

export interface PaymentRequirement { scheme: string; network: string; amount: string; asset: string; payTo: string }
const b64json = (s: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));

/** Ask the paid route its price without paying: the 402 answer carries it. Works with or without a claim header. */
export async function discoverPrice(url: string, claimHeader?: string): Promise<{ requirement: PaymentRequirement; paymentRequired: unknown }> {
  const r = await fetch(url, { headers: claimHeader ? { "x-noux-claim": claimHeader } : {} });
  if (r.status !== 402) throw new Error(r.ok ? "This endpoint is not asking for payment." : `The endpoint answered ${r.status}.`);
  const h = r.headers.get("payment-required");
  const body: any = h ? b64json(h) : await r.json().catch(() => null);
  const req = body?.accepts?.[0];
  if (!req?.amount) throw new Error("The endpoint did not say what it costs.");
  return { requirement: req as PaymentRequirement, paymentRequired: body };
}

export async function requestClaim(a: { campaign: string; distributor: string; buyer: string; price: string; signMessage: (m: Uint8Array) => Promise<Uint8Array> }) {
  const ts = Math.floor(Date.now() / 1000);
  const msg = new TextEncoder().encode(`NOUX-CLAIM-REQ-v1|${a.campaign}|${a.distributor}|${a.buyer}|${a.price}|${ts}`);
  const sig = await a.signMessage(msg);
  const r = await fetch(`${API_BASE}/claims`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ campaign: a.campaign, distributor: a.distributor, buyer: a.buyer, price: a.price, ts, buyerSignature: btoa(String.fromCharCode(...sig)) }) });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j?.error?.message ?? `HTTP ${r.status}`), { code: j?.error?.code as string | undefined });
  return j.claim as Record<string, unknown> & { nonce: string; expiry: number };
}
export const encodeClaimHeader = (claim: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(claim))));

/** Devnet USDC balance (base units) of an owner, 0 when the token account does not exist yet. */
export async function usdcBalance(ownerAta: string): Promise<bigint> {
  const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: [ownerAta, { commitment: "confirmed" }] }) }).then((x) => x.json());
  return r.result?.value?.amount ? BigInt(r.result.value.amount) : 0n;
}

/** Pay a 402 route with the buyer's wallet. The facilitator is the transaction's fee payer; the wallet only adds the buyer's signature. */
export async function payWithWallet(a: { url: string; claimHeader?: string; address: string; signRaw: (tx: Uint8Array) => Promise<Uint8Array> }) {
  const [{ x402Client, wrapFetchWithPayment, decodePaymentResponseHeader }, { ExactSvmScheme }, kit] = await Promise.all([import("@x402/fetch"), import("@x402/svm/exact/client"), import("@solana/kit")]);
  const enc = kit.getTransactionEncoder(), dec = kit.getTransactionDecoder();
  const addr = kit.address(a.address);
  // a kit "partial signer" backed by the wallet: it signs the bytes and hands back only the buyer's signature
  const signer = {
    address: addr,
    signTransactions: async (txs: readonly any[]) => Promise.all(txs.map(async (tx) => {
      const signed = dec.decode(await a.signRaw(new Uint8Array(enc.encode(tx))));
      const sig = (signed.signatures as Record<string, Uint8Array | null>)[a.address];
      if (!sig) throw new Error("The wallet did not sign the payment.");
      return { [a.address]: sig } as any;
    })),
  };
  const pay = wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmScheme(signer as any)));
  const r = await pay(a.url, { headers: a.claimHeader ? { "x-noux-claim": a.claimHeader } : {} });
  const ph = r.headers.get("payment-response");
  let tx: string | undefined; try { tx = ph ? (decodePaymentResponseHeader(ph) as any).transaction : undefined; } catch { /* header is informational */ }
  const text = await r.text();
  return { status: r.status, body: text, tx };
}
