import { Hono } from "hono";
import { z } from "zod";
import { issueClaim, IssuanceError, type Deps } from "./issuance";

const body = z.object({
  campaign: z.string().min(32).max(44), distributor: z.string().min(32).max(44), buyer: z.string().min(32).max(44),
  price: z.string().regex(/^\d{1,20}$/), ts: z.number().int(), buyerSignature: z.string().min(80).max(100),
}).strict();

export function createApp(deps: Deps, opts: { trustProxy: boolean; clientIp?: (c: any) => string } = { trustProxy: false }) {
  const app = new Hono();
  const ipOf = (c: any): string => {
    if (opts.clientIp) return opts.clientIp(c);
    if (opts.trustProxy) { const f = c.req.header("x-forwarded-for"); if (f) return f.split(",")[0].trim(); }
    return c.env?.incoming?.socket?.remoteAddress ?? "unknown";
  };
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
