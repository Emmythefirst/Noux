import type { Connection, PublicKey } from "@solana/web3.js";
import { BRAND, type CampaignReader, type SignedClaim } from "@noux/core";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { FacilitatorClient } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { evaluateClaim, type ClaimRejection } from "./claim-check";
import { vaultFundedCheck, type SaleOpener, type SaleSettler } from "./chain";
import { ResilientFacilitator, type ResilientOptions } from "./resilient-facilitator";

export type GatewayEvent =
  | { type: "claim_rejected"; route: string; reason: ClaimRejection }
  | { type: "claim_accepted"; route: string; sale: string; distributor: string; buyer: string }
  | { type: "sale_open_failed"; route: string; error: string }
  | { type: "payer_mismatch"; sale: string; payer?: string; expected: string }
  | { type: "unknown_payto"; payTo: string }
  | { type: "settle_after_delivery"; sale: string; signature: string | null }
  | { type: "settle_after_delivery_failed"; sale: string; error: string }
  | { type: "facilitator"; detail: unknown };

export interface RouteSpec { /** Price in base units of the campaign mint. */ price: bigint; description?: string }

export interface NouxGatewayConfig {
  programId: PublicKey;
  cluster: string;
  campaign: PublicKey;
  mint: PublicKey;
  /** CAIP-2 network id, e.g. "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" (devnet). */
  network: string;
  /** Wallet that is paid in full when there is no (valid) claim. */
  merchantPayTo: PublicKey;
  facilitator: FacilitatorClient;
  connection: Connection;
  campaigns: CampaignReader;
  opener: SaleOpener;
  /** If set, the merchant settles each sale right after the resource was delivered; otherwise the sweeper settles after the hold. */
  settler?: SaleSettler;
  /** "GET /path" -> spec. The claim's price must equal the route's price exactly. */
  routes: Record<string, RouteSpec>;
  /** How long the buyer's response may wait for the merchant's settle-after-delivery (default 0: never; the settle runs detached). */
  settleAfterDeliveryWaitMs?: number;
  /** Longest the 402 answer may wait for the sale to open on-chain (default 20 s). Beyond it the gateway fails open: the buyer pays the merchant in full and the referral is lost. */
  openTimeoutMs?: number;
  minClaimLifeSecs?: number;
  now?: () => number;
  onEvent?: (e: GatewayEvent) => void;
  resilient?: Pick<ResilientOptions, "sleep" | "backoffMs" | "confirmDelaysMs" | "maxAttempts" | "maxSettleAttempts">;
}

const MAX_TRACKED = 10_000;
const SETTLE_DEADLINE_MS = 60_000;

/**
 * Express middleware that makes a paid x402 route referral-aware.
 *  - valid, route-priced, buyer-bound claim  -> payTo = per-sale vault (sale opened on-chain first)
 *  - missing / invalid claim                 -> payTo = merchant wallet: full payment, no commission
 *  - payer must equal the claim's buyer (checked after the facilitator verifies, before anything settles)
 *  - facilitator calls are wrapped in ResilientFacilitator (check-chain-before-retry settle)
 */
export function createNouxGateway(cfg: NouxGatewayConfig) {
  const emit = (e: GatewayEvent) => { try { cfg.onEvent?.(e); } catch { /* observers must never break payments */ } };
  const now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  const merchant = cfg.merchantPayTo.toBase58();
  const sales = new Map<string, SignedClaim>(); // sale vault owner (base58) -> claim; bounded
  const remember = (sale: string, c: SignedClaim) => { sales.set(sale, c); if (sales.size > MAX_TRACKED) sales.delete(sales.keys().next().value as string); };
  // One answer per claim: the buyer signs a payment for the payee in the FIRST 402 and sends it on the retry. If a retry could get a different payee (the open failed
  // the first time and works now, or the other way round) the payment would be refused. So the first decision stands until the claim expires.
  const decided = new Map<string, { payTo: string; until: number }>();
  const decide = (key: string, payTo: string, until: number) => { decided.set(key, { payTo, until }); if (decided.size > MAX_TRACKED) decided.delete(decided.keys().next().value as string); return payTo; };
  const openTimeoutMs = cfg.openTimeoutMs ?? 20_000;
  const openWithin = (claim: SignedClaim) => new Promise<PublicKey>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`opening the sale took longer than ${openTimeoutMs} ms`)), openTimeoutMs); timer.unref?.();
    cfg.opener.ensureOpen(claim).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

  const payToFor = (routeKey: string, spec: RouteSpec) => async (ctx: { adapter: { getHeader(n: string): string | undefined } }): Promise<string> => {
    const header = ctx.adapter.getHeader(BRAND.claimHeader);
    if (!header) return merchant; // plain purchase
    const info = await cfg.campaigns.get(cfg.campaign).catch(() => null);
    if (!info) { emit({ type: "claim_rejected", route: routeKey, reason: "wrong_campaign" }); return merchant; }
    const d = evaluateClaim(header, {
      programId: cfg.programId, cluster: cfg.cluster, campaign: cfg.campaign, attributionKey: info.attributionKey,
      routePrice: spec.price, nowSec: now(), minLifeSecs: cfg.minClaimLifeSecs ?? 120,
    });
    if (!d.ok) { emit({ type: "claim_rejected", route: routeKey, reason: d.reason }); return merchant; }
    const key = Buffer.from(d.claim.nonce).toString("hex"), prior = decided.get(key);
    if (prior && prior.until > now()) { if (prior.payTo !== merchant) remember(prior.payTo, d.claim); return prior.payTo; } // same answer as the first request for this claim
    try {
      const sale = (await openWithin(d.claim)).toBase58();
      remember(sale, d.claim);
      emit({ type: "claim_accepted", route: routeKey, sale, distributor: d.claim.distributor.toBase58(), buyer: d.claim.buyer.toBase58() });
      return decide(key, sale, d.claim.expiry);
    } catch (e) {
      // Fail open for the BUYER: they can still buy, the merchant is paid, only the referral is lost.
      emit({ type: "sale_open_failed", route: routeKey, error: String((e as Error).message).slice(0, 200) });
      return decide(key, merchant, d.claim.expiry);
    }
  };

  const facilitator = new ResilientFacilitator(cfg.facilitator, {
    ...cfg.resilient,
    confirmLanded: vaultFundedCheck(cfg.connection, cfg.mint, (p) => sales.has(p)) as ResilientOptions["confirmLanded"],
    onEvent: (e) => emit({ type: "facilitator", detail: e }),
  });
  const server = new x402ResourceServer(facilitator).register(cfg.network as any, new ExactSvmScheme());

  server.onAfterVerify(async ({ requirements, result }) => {
    const payTo = requirements.payTo;
    if (payTo === merchant) return; // plain purchase: any payer is fine
    const claim = sales.get(payTo);
    if (!claim) { emit({ type: "unknown_payto", payTo }); return { abort: true as const, reason: "unknown_payto", message: "payment target is not a known sale" }; }
    if (result.payer !== claim.buyer.toBase58()) {
      emit({ type: "payer_mismatch", sale: payTo, payer: result.payer, expected: claim.buyer.toBase58() });
      return { abort: true as const, reason: "payer_mismatch", message: "payer is not the buyer bound to this claim" };
    }
  });

  server.onAfterSettle(async ({ requirements }) => {
    const sale = requirements.payTo;
    const claim = sales.get(sale);
    if (!claim || !cfg.settler) return; // merchant payment, or sweeper will settle after the hold
    // The buyer has paid and been served: their response must not wait for a second on-chain transaction. The settle runs
    // detached (the keeper is the backstop) with a hard deadline so a hung RPC cannot leak work forever.
    const run = new Promise<void>((done) => {
      let over = false;
      const timer = setTimeout(() => { over = true; emit({ type: "settle_after_delivery_failed", sale, error: "timed out; the keeper settles after the hold" }); done(); }, SETTLE_DEADLINE_MS);
      timer.unref?.();
      cfg.settler!.settle(claim).then(
        (signature) => { clearTimeout(timer); if (!over) emit({ type: "settle_after_delivery", sale, signature }); },
        (e) => { clearTimeout(timer); if (!over) emit({ type: "settle_after_delivery_failed", sale, error: String((e as Error).message).slice(0, 200) }); },
      ).finally(done);
    });
    const wait = cfg.settleAfterDeliveryWaitMs ?? 0;
    if (wait > 0) await Promise.race([run, new Promise((r) => setTimeout(r, wait).unref?.())]);
  });

  const routes: Record<string, any> = {};
  for (const [key, spec] of Object.entries(cfg.routes)) {
    routes[key] = {
      accepts: [{ scheme: "exact", network: cfg.network, payTo: payToFor(key, spec), price: { asset: cfg.mint.toBase58(), amount: spec.price.toString() } }],
      description: spec.description ?? key,
    };
  }
  return { middleware: paymentMiddleware(routes as any, server), server, facilitator, trackedSales: () => sales.size };
}
