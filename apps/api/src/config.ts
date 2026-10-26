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
  /** Set to "1" only behind a proxy you control (Railway/Vercel): trusts X-Forwarded-For for the client IP. */
  TRUST_PROXY: z.enum(["0", "1"]).default("0"),
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
