import { z } from "zod";

const NETWORKS: Record<string, string> = { devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" };

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8790),
  RPC_URL: z.string().url(),
  PROGRAM_ID: z.string().min(32),
  CLUSTER: z.string().min(1).max(8),
  /** The campaign this service sells under (created on-chain by the merchant). */
  CAMPAIGN: z.string().min(32),
  MINT: z.string().min(32),
  /** Wallet paid in full when a call has no valid claim. */
  MERCHANT_PAYTO: z.string().min(32),
  /** Pays rent for sales it opens. Hot key with a small SOL float. */
  GATEWAY_PAYER_B58: z.string().min(40),
  /** The campaign merchant's key: lets this service settle right after delivery and refund. Optional: without it the keeper settles after the hold. */
  MERCHANT_SIGNER_B58: z.string().min(40).optional(),
  FACILITATOR: z.enum(["cdp", "x402.org"]).default("cdp"),
  CDP_API_KEY_ID: z.string().optional(),
  CDP_API_KEY_SECRET: z.string().optional(),
  /** Same secret, hex-encoded (only 0-9a-f). Wins over CDP_API_KEY_SECRET when set. Immune to paste/parser mangling of '+', '/', '='. */
  CDP_API_KEY_SECRET_HEX: z.string().regex(/^[0-9a-fA-F]+$/, "must be hex").optional(),
  /** Where buyers/agents request claims. Shown in /v1/info. */
  CLAIMS_API_URL: z.string().url().default("https://noux-api.onrender.com"),
  PUBLIC_URL: z.string().url().optional(),
}).superRefine((v, ctx) => {
  if (v.FACILITATOR === "cdp" && (!v.CDP_API_KEY_ID || !(v.CDP_API_KEY_SECRET || v.CDP_API_KEY_SECRET_HEX))) ctx.addIssue({ code: "custom", path: ["CDP_API_KEY_ID"], message: "required when FACILITATOR=cdp" });
  if (!NETWORKS[v.CLUSTER]) ctx.addIssue({ code: "custom", path: ["CLUSTER"], message: "must be devnet or mainnet" });
});
export type Config = z.infer<typeof schema> & { NETWORK: string };
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) throw new Error("invalid configuration: " + r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")); // names only, never values
  const d = r.data;
  if (d.CDP_API_KEY_SECRET_HEX) d.CDP_API_KEY_SECRET = Buffer.from(d.CDP_API_KEY_SECRET_HEX, "hex").toString("utf8");
  return { ...d, NETWORK: NETWORKS[d.CLUSTER] };
}
