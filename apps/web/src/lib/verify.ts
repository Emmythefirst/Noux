// Browser-side receipt verification. It reads the sale and campaign accounts and the two transactions straight from a Solana
// RPC node and re-does the checks. It does NOT use the Noux API for any of the facts it checks: the API receipt is only the
// thing being checked. Plain JSON-RPC + a tiny base58/borsh reader, so no Solana SDK ships to the browser.

export const RPC_URL: string = (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";
const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111";
const CLAIM_TAG = "NOUX-CLAIM-v1";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error("bad base58");
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch === "1") bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}
export function b58encode(buf: Uint8Array): string {
  const digits: number[] = [];
  for (const b of buf) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of buf) { if (b === 0) out += "1"; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export interface SaleAccount {
  campaign: string; distributor: string; buyer: string; nonce: Uint8Array; expiry: bigint; openedAt: bigint; holdUntil: bigint; settledAt: bigint;
  price: bigint; gross: bigint; merchantAmount: bigint; commissionAmount: bigint; feeAmount: bigint; commissionBps: number; feeBps: number; status: "open" | "settled" | "refunded";
}
export interface CampaignAccount { mint: string; attributionKey: string; cluster: Uint8Array; commissionBps: number; feeBps: number }

export function decodeSale(data: Uint8Array): SaleAccount {
  if (data.length < 246) throw new Error("account is too small to be a sale");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pk = (o: number) => b58encode(data.slice(o, o + 32));
  const u64 = (o: number) => v.getBigUint64(o, true);
  const status = (["open", "settled", "refunded"] as const)[data[244]];
  if (!status) throw new Error("unknown sale status");
  return {
    campaign: pk(8), distributor: pk(40), buyer: pk(72), nonce: data.slice(136, 168),
    expiry: v.getBigInt64(168, true), openedAt: v.getBigInt64(176, true), holdUntil: v.getBigInt64(184, true), settledAt: v.getBigInt64(192, true),
    price: u64(200), gross: u64(208), merchantAmount: u64(216), commissionAmount: u64(224), feeAmount: u64(232),
    commissionBps: v.getUint16(240, true), feeBps: v.getUint16(242, true), status,
  };
}
export function decodeCampaign(data: Uint8Array): CampaignAccount {
  if (data.length < 193) throw new Error("account is too small to be a campaign");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { mint: b58encode(data.slice(40, 72)), attributionKey: b58encode(data.slice(104, 136)), cluster: data.slice(136, 144), commissionBps: v.getUint16(188, true), feeBps: v.getUint16(190, true) };
}

/** The exact message the program checks: tag | program id | cluster(8) | campaign | distributor | buyer | expiry i64 | price u64 | nonce (197 bytes). */
export function claimMessage(programId: string, cluster: Uint8Array, s: SaleAccount): Uint8Array {
  const out = new Uint8Array(13 + 32 + 8 + 32 * 3 + 8 + 8 + 32);
  const dv = new DataView(out.buffer);
  let o = 0;
  const put = (b: Uint8Array) => { out.set(b, o); o += b.length; };
  put(new TextEncoder().encode(CLAIM_TAG)); put(b58decode(programId)); put(cluster);
  put(b58decode(s.campaign)); put(b58decode(s.distributor)); put(b58decode(s.buyer));
  dv.setBigInt64(o, s.expiry, true); o += 8; dv.setBigUint64(o, s.price, true); o += 8; put(s.nonce);
  return out;
}

/** Pull (pubkey, message) out of an ed25519 precompile instruction's data. */
export function parseEd25519(data: Uint8Array): { pubkey: Uint8Array; message: Uint8Array } | null {
  if (data.length < 16 || data[0] !== 1) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pkOff = v.getUint16(6, true), msgOff = v.getUint16(10, true), msgLen = v.getUint16(12, true);
  if (pkOff + 32 > data.length || msgOff + msgLen > data.length) return null;
  return { pubkey: data.slice(pkOff, pkOff + 32), message: data.slice(msgOff, msgOff + msgLen) };
}

export interface SplitCheck { ok: boolean; detail: string; capApplied: boolean }
/** fee and commission are floored; commission may be LOWER than the floor only if the budget cap bit; the merchant gets the remainder. */
export function checkSplit(s: Pick<SaleAccount, "gross" | "merchantAmount" | "commissionAmount" | "feeAmount" | "commissionBps" | "feeBps">): SplitCheck {
  const fee = (s.gross * BigInt(s.feeBps)) / 10000n;
  const wanted = (s.gross * BigInt(s.commissionBps)) / 10000n;
  const capApplied = s.commissionAmount < wanted;
  if (s.feeAmount !== fee) return { ok: false, capApplied, detail: `fee is ${s.feeAmount}, the terms give ${fee}` };
  if (s.commissionAmount > wanted) return { ok: false, capApplied, detail: `commission ${s.commissionAmount} exceeds ${wanted}` };
  if (s.merchantAmount !== s.gross - s.commissionAmount - s.feeAmount) return { ok: false, capApplied, detail: "merchant share is not the remainder" };
  return { ok: true, capApplied, detail: capApplied ? "commission was reduced by the budget cap" : "fee and commission floored, merchant got the remainder" };
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let last: Error | null = null;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (r.status === 429) { await new Promise((res) => setTimeout(res, 600 * (i + 1))); continue; }
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result as T;
    } catch (e) { last = e as Error; await new Promise((res) => setTimeout(res, 400)); }
  }
  throw last ?? new Error("RPC unavailable");
}

async function account(addr: string): Promise<{ data: Uint8Array; owner: string } | null> {
  const r = await rpc<{ value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [addr, { encoding: "base64", commitment: "confirmed" }]);
  return r.value ? { data: b64(r.value.data[0]), owner: r.value.owner } : null;
}
interface Tx {
  meta: { err: unknown; preTokenBalances?: TB[]; postTokenBalances?: TB[] } | null;
  transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; data: string }[] } };
}
interface TB { mint: string; owner?: string; uiTokenAmount: { amount: string } }
const tx = (sig: string) => rpc<Tx | null>("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);

export const sigFromUrl = (u: string | null) => u?.match(/\/tx\/([1-9A-HJ-NP-Za-km-z]+)/)?.[1] ?? null;

export type StepState = { state: "pass" | "fail" | "skip"; detail: string };
export interface VerifyInput { sale: string; openTx: string | null; paymentTx: string | null; apiGross: string; apiSplit: { merchant: string; distributor: string; protocolFee: string } }
const bal = (list: TB[] | undefined, owner: string, mint: string) => (list ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);

/** Four checks in the order the page shows them. Every fact comes from the RPC node, never from the Noux API. */
export async function verifyReceipt(i: VerifyInput): Promise<StepState[]> {
  const fail = (detail: string): StepState => ({ state: "fail", detail });
  const skip = (detail: string): StepState => ({ state: "skip", detail });
  const saleAcc = await account(i.sale);
  if (!saleAcc) return [fail("Sale account not found on-chain"), skip(""), skip(""), skip("")];
  const sale = decodeSale(saleAcc.data);
  const programId = saleAcc.owner; // the program that owns the sale account is the program whose rules apply
  const campAcc = await account(sale.campaign);
  if (!campAcc || campAcc.owner !== programId) return [fail("Campaign account missing or not owned by the same program"), skip(""), skip(""), skip("")];
  const camp = decodeCampaign(campAcc.data);

  // 1. claim signature: the open transaction carries an ed25519 precompile instruction over exactly this claim, from the campaign's attribution key
  let s1: StepState;
  try {
    const sig = sigFromUrl(i.openTx);
    const t = sig ? await tx(sig) : null;
    if (!t) s1 = skip("Open transaction not available from the node");
    else if (t.meta?.err) s1 = fail("The open transaction failed");
    else {
      const keys = t.transaction.message.accountKeys;
      const want = claimMessage(programId, camp.cluster, sale);
      const hit = t.transaction.message.instructions.filter((x) => keys[x.programIdIndex] === ED25519_PROGRAM).map((x) => parseEd25519(b58decode(x.data))).find((p) => p && eq(p.message, want));
      s1 = !hit ? fail("No signature over this exact claim was found in the open transaction")
        : b58encode(hit.pubkey) !== camp.attributionKey ? fail("Claim was signed by a key that is not the campaign’s attribution key")
        : { state: "pass", detail: "Signed by the campaign’s attribution key; Solana’s ed25519 program verified it when the sale opened" };
    }
  } catch (e) { s1 = skip("Couldn’t read the open transaction: " + (e as Error).message); }

  // 2. payer equals the claim's buyer: the buyer's token balance fell by the amount and the sale vault's rose by it
  let s2: StepState;
  try {
    if (sale.gross === 0n) s2 = skip("Nothing has been paid into this sale");
    else {
      const sig = sigFromUrl(i.paymentTx);
      const t = sig ? await tx(sig) : null;
      if (!t || !t.meta) s2 = skip("Payment transaction not available from the node");
      else if (t.meta.err) s2 = fail("The payment transaction failed");
      else {
        const paid = bal(t.meta.preTokenBalances, sale.buyer, camp.mint) - bal(t.meta.postTokenBalances, sale.buyer, camp.mint);
        const vault = bal(t.meta.postTokenBalances, i.sale, camp.mint) - bal(t.meta.preTokenBalances, i.sale, camp.mint);
        s2 = paid === sale.gross && vault === sale.gross ? { state: "pass", detail: `The claim’s buyer paid ${sale.gross} base units into this sale’s vault` }
          : fail(`Buyer balance fell by ${paid}, vault rose by ${vault}, sale records ${sale.gross}`);
      }
    }
  } catch (e) { s2 = skip("Couldn’t read the payment transaction: " + (e as Error).message); }

  // 3. split matches the terms recorded on the sale, and the page shows the same numbers
  let s3: StepState;
  if (sale.status === "refunded") s3 = skip("Refunded: the whole payment went back to the buyer");
  else if (sale.status === "open") s3 = skip("Not settled yet: no split has happened");
  else {
    const c = checkSplit(sale);
    const same = i.apiGross === sale.gross.toString() && i.apiSplit.merchant === sale.merchantAmount.toString() && i.apiSplit.distributor === sale.commissionAmount.toString() && i.apiSplit.protocolFee === sale.feeAmount.toString();
    s3 = !c.ok ? fail(c.detail) : !same ? fail("This page’s numbers differ from the on-chain sale account") : { state: "pass", detail: c.detail + "; matches this page" };
  }

  // 4. parts add up exactly
  const s4: StepState = sale.status !== "settled" ? skip("Only settled sales split a payment")
    : sale.merchantAmount + sale.commissionAmount + sale.feeAmount === sale.gross ? { state: "pass", detail: `${sale.merchantAmount} + ${sale.commissionAmount} + ${sale.feeAmount} = ${sale.gross}` }
    : fail("The parts do not add up to the amount paid");
  return [s1, s2, s3, s4];
}
