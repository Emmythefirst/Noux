import type { FacilitatorClient } from "@x402/core/server";

type Payload = Parameters<FacilitatorClient["verify"]>[0];
type Requirements = Parameters<FacilitatorClient["verify"]>[1];
type SettleResponse = Awaited<ReturnType<FacilitatorClient["settle"]>>;

/** What the chain says about a payment whose settle call failed ambiguously. */
export type LandedCheck =
  | { landed: true; transaction?: string; payer?: string }
  | { landed: false }
  | { landed: "unknown" };

export interface ResilientOptions {
  /** Attempts for idempotent calls (verify, getSupported). */
  maxAttempts?: number;
  /** Max settle submissions (each preceded by an on-chain check after the first). */
  maxSettleAttempts?: number;
  backoffMs?: (attempt: number) => number;
  /** Delays between on-chain checks after an ambiguous settle failure (lets confirmation arrive). */
  confirmDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /**
   * Did this payment already land on-chain? For Noux: is the per-sale vault funded with >= the required amount.
   * MUST read chain state only; it must never sign or send anything.
   */
  confirmLanded: (payload: Payload, requirements: Requirements) => Promise<LandedCheck>;
  onEvent?: (e: { type: string; detail?: unknown }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Network-level / server-side trouble where the facilitator's answer is unknown. A definitive refusal is NOT this. */
export function isAmbiguous(e: unknown): boolean {
  const m = String((e as any)?.message ?? e) + " " + String((e as any)?.cause?.code ?? "") + " " + String((e as any)?.cause?.message ?? "");
  return /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR|socket hang up|timed? ?out|aborted|\b(500|502|503|504|429)\b|Too Many Requests/i.test(m) || PENDING.test(m);
}

/** The facilitator submitted the payment but did not see it confirm before ITS deadline ("settlement_pending ... did not confirm in time ... context deadline exceeded"). The payment may still land: not a refusal. */
const PENDING = /settlement_pending|did not confirm in time|context deadline exceeded/i;
const isPendingResponse = (r: unknown) => !!r && (r as any).success === false && PENDING.test(`${(r as any).errorReason ?? ""} ${(r as any).errorMessage ?? ""}`);

/**
 * Wraps any x402 FacilitatorClient with retry rules that are safe for money:
 *  - verify / getSupported: pure reads at the facilitator => retried with backoff on ambiguous failures.
 *  - settle: submits a transaction that already carries the buyer's signature. We NEVER re-sign or rebuild it;
 *    the very same payload is resubmitted, and only after the chain confirms it has NOT already landed.
 *    (A timed-out settle may have succeeded.) A definitive `success:false` from the facilitator is never retried; a "pending / did not confirm in time" answer is NOT definitive and gets the chain check.
 */
export class ResilientFacilitator implements FacilitatorClient {
  private o: Required<Omit<ResilientOptions, "confirmLanded" | "onEvent">> & Pick<ResilientOptions, "confirmLanded" | "onEvent">;
  constructor(private inner: FacilitatorClient, opts: ResilientOptions) {
    this.o = {
      maxAttempts: 4, maxSettleAttempts: 3, backoffMs: (a) => 400 * 2 ** (a - 1), confirmDelaysMs: [1500, 3000], sleep: defaultSleep, ...opts,
    };
  }
  private emit(type: string, detail?: unknown) { this.o.onEvent?.({ type, detail }); }

  private async retryRead<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let a = 1; a <= this.o.maxAttempts; a++) {
      try { return await fn(); } catch (e) {
        last = e;
        if (!isAmbiguous(e) || a === this.o.maxAttempts) throw e;
        this.emit(`${label}_retry`, { attempt: a, error: String((e as Error).message) });
        await this.o.sleep(this.o.backoffMs(a));
      }
    }
    throw last;
  }

  verify(payload: Payload, requirements: Requirements) { return this.retryRead("verify", () => this.inner.verify(payload, requirements)); }
  getSupported() { return this.retryRead("supported", () => this.inner.getSupported()); }

  async settle(payload: Payload, requirements: Requirements): Promise<SettleResponse> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.o.maxSettleAttempts; attempt++) {
      try {
        const res = await this.inner.settle(payload, requirements);
        if (!isPendingResponse(res)) return res; // definitive success/failure responses return here untouched
        throw new Error(`${(res as any).errorReason ?? "settlement_pending"}: ${(res as any).errorMessage ?? "did not confirm in time"}`); // ambiguous: look at the chain before deciding
      } catch (e) {
        lastErr = e;
        if (!isAmbiguous(e)) throw e; // e.g. the facilitator rejected it: not our call to retry
        this.emit("settle_ambiguous", { attempt, error: String((e as Error).message) });
        const landed = await this.checkLanded(payload, requirements);
        if (landed.landed === true) {
          this.emit("settle_already_landed", landed);
          return { success: true, payer: landed.payer ?? "", transaction: landed.transaction ?? "", network: requirements.network } as SettleResponse;
        }
        if (landed.landed === "unknown") throw new Error("settle outcome unknown: could not confirm on-chain state; not retrying blindly", { cause: e });
        // landed === false: confirmed absent => resubmitting the SAME signed payload is safe
        if (attempt === this.o.maxSettleAttempts) break;
        await this.o.sleep(this.o.backoffMs(attempt));
      }
    }
    throw lastErr;
  }

  /** Several looks, with delays: a settle that "timed out" may just not be confirmed yet. */
  private async checkLanded(payload: Payload, requirements: Requirements): Promise<LandedCheck> {
    let result: LandedCheck = { landed: false };
    for (const delay of [0, ...this.o.confirmDelaysMs]) {
      if (delay) await this.o.sleep(delay);
      try { result = await this.o.confirmLanded(payload, requirements); } catch { result = { landed: "unknown" }; }
      if (result.landed === true) return result;
    }
    return result;
  }
}
