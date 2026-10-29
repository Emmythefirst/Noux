import { z } from "zod";

const num = (def: number) => z.coerce.number().int().positive().default(def);
const schema = z.object({
  PORT: num(8787),
  DATABASE_URL: z.string().min(1),
  RPC_URL: z.string().url(),
  PROGRAM_ID: z.string().min(32),
  /** <= 8 ascii chars; must equal the cluster tag stored in every campaign this service signs for. */
  CLUSTER: z.string().min(1).max(8),
  /** Path to a JSON secret-key file (mode 600). Preferred. */
  ATTRIBUTION_KEY_FILE: z.string().optional(),
  /** Base58 secret key in an env var (for PaaS secret stores). Ignored if a file is given. */
  ATTRIBUTION_KEY_B58: z.string().optional(),
  CLAIM_TTL_SECS: num(600),
  MAX_PRICE_BASE_UNITS: z.coerce.bigint().positive().default(100_000_000n), // 100 USDC
  LIMIT_PER_DISTRIBUTOR_PER_MIN: num(30),
  LIMIT_PER_BUYER_PER_MIN: num(10),
  LIMIT_PER_CAMPAIGN_PER_MIN: num(120),
  LIMIT_PER_IP_PER_MIN: num(60),
  /** Optional embedded keeper: set BOTH to run the settlement keeper inside this process (saves a paid worker). */
  MINT: z.string().min(32).optional(),
  KEEPER_PAYER_B58: z.string().min(40).optional(),
  KEEPER_TICK_SECONDS: num(30),
  /** Indexer (public directory/receipts). Runs inside this process. */
  ENABLE_INDEXER: z.enum(["0", "1"]).default("1"),
  /** "incremental" follows new program transactions and re-reads only what they touched (plus open sales), with a full snapshot at start and every 6 h; "full" downloads every account each pass (escape hatch). */
  INDEXER_MODE: z.enum(["incremental", "full"]).default("incremental"),
  INDEXER_INTERVAL_SECONDS: num(60),
  MINT_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  /** Set to "1" only behind a proxy you control (Railway/Vercel): trusts X-Forwarded-For for the client IP. */
  TRUST_PROXY: z.enum(["0", "1"]).default("0"),
  /** How many trusted proxy entries sit in front of this service. On Render it is 3 (observed 2026-10-29 with GET /v1/whoami: client, Cloudflare edge, Render's internal proxy). The client address is the hops-th X-Forwarded-For entry from the RIGHT; entries to the left are client-controlled and ignored. Check with GET /v1/whoami. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(5).default(3),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    // Report only which variables are wrong - never echo values (they may be secrets).
    throw new Error("invalid configuration: " + r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return r.data;
}
