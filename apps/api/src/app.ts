import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { issueClaim, IssuanceError, type Deps } from "./issuance";
import { publicRoutes, type PublicDeps } from "./public/routes";

const body = z.object({
  campaign: z.string().min(32).max(44), distributor: z.string().min(32).max(44), buyer: z.string().min(32).max(44),
  price: z.string().regex(/^\d{1,20}$/), ts: z.number().int(), buyerSignature: z.string().min(80).max(100),
}).strict();

export function createApp(deps: Deps, opts: { trustProxy: boolean; clientIp?: (c: any) => string; public?: PublicDeps; readLimitPerMin?: number } = { trustProxy: false }) {
  const app = new Hono();
  // Browsers (the directory UI, buyer agents in a page) call this API cross-origin. No cookies or credentials are used anywhere.
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowHeaders: ["content-type"], maxAge: 600 }));
  const ipOf = (c: any): string => {
    if (opts.clientIp) return opts.clientIp(c);
    if (opts.trustProxy) { const f = c.req.header("x-forwarded-for"); if (f) return f.split(",")[0].trim(); }
    return c.env?.incoming?.socket?.remoteAddress ?? "unknown";
  };
  if (opts.public) {
    // coarse per-IP read limiter (in memory; the claim-issuance limits are the Postgres-backed ones)
    const max = opts.readLimitPerMin ?? 240; const hits = new Map<string, { n: number; reset: number }>();
    app.use("/v1/*", async (c, next) => {
      if (c.req.method === "POST") return next();
      const ip = ipOf(c), t = Date.now(); let h = hits.get(ip);
      if (!h || t > h.reset) { h = { n: 0, reset: t + 60_000 }; hits.set(ip, h); if (hits.size > 5000) hits.clear(); }
      if (++h.n > max) { c.header("Retry-After", "30"); return c.json({ error: { code: "rate_limited", message: "too many requests" } }, 429); }
      return next();
    });
    app.route("/v1", publicRoutes(opts.public));
    // What a new campaign must name as its attribution key for this service to issue claims for it. Public keys only.
    app.get("/v1/claim-service", (c) => c.json({ attributionKey: deps.signer.publicKey.toBase58(), cluster: deps.cfg.CLUSTER, programId: deps.cfg.PROGRAM_ID, claimTtlSecs: deps.cfg.CLAIM_TTL_SECS }));
  }
  app.get("/healthz", (c) => c.json({ ok: true, attributionKey: deps.signer.publicKey.toBase58(), cluster: deps.cfg.CLUSTER }));

  app.post("/v1/claims", async (c) => {
    let json: unknown;
    try { json = await c.req.json(); } catch { return c.json({ error: { code: "bad_request", message: "body must be JSON" } }, 400); }
    const parsed = body.safeParse(json);
    if (!parsed.success) return c.json({ error: { code: "bad_request", message: "invalid body", fields: parsed.error.issues.map((i) => i.path.join(".")) } }, 400);
    try {
      return c.json({ claim: await issueClaim(deps, parsed.data, ipOf(c)) }, 201);
    } catch (e) {
      if (e instanceof IssuanceError) {
        if (e.retryAfterSec) c.header("Retry-After", String(e.retryAfterSec));
        return c.json({ error: { code: e.code, message: e.message } }, e.status);
      }
      console.error("claim issuance failed:", (e as Error).message); // message only: never log request bodies or keys
      return c.json({ error: { code: "internal", message: "internal error" } }, 503);
    }
  });
  return app;
}
