import { API_BASE } from "./api";
import { listingMessage, type ListingInput } from "./program";

/**
 * Sign the listing with the merchant wallet and publish it. The API reads the campaign's merchant from the CHAIN, so only the
 * wallet that created the campaign can list it, and the request must be fresh (60 s). A brand-new campaign may not be indexed
 * yet, so a 404 is retried for a few seconds.
 */
export async function publishListing(campaign: string, listing: ListingInput, signMessage: (m: Uint8Array) => Promise<Uint8Array>, tries = 6): Promise<void> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signMessage(await listingMessage(campaign, listing, ts));
  let last = "";
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${API_BASE}/campaigns/${campaign}/listing`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ listing, ts, signature: btoa(String.fromCharCode(...sig)) }) });
    if (r.ok) return;
    last = ((await r.json().catch(() => null)) as any)?.error?.message ?? `HTTP ${r.status}`;
    if (r.status !== 404) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(last);
}

export function validateListing(l: ListingInput): string | null {
  if (!l.name.trim() || l.name.length > 60) return "Name is required (up to 60 characters).";
  if (!l.description.trim() || l.description.length > 280) return "Description is required (up to 280 characters).";
  if (!/^https:\/\/[^\s/$.?#].[^\s]*$/.test(l.endpointUrl) || l.endpointUrl.length > 200) return "Endpoint URL must be a public https address.";
  if (!l.route.trim() || l.route.length > 80) return "Route is required, for example GET /report.";
  if (!l.displayPrice.trim() || l.displayPrice.length > 20) return "Display price is required, for example $0.10.";
  return null;
}

/** Remove a campaign from the public directory (the campaign itself stays on-chain). Signed by the merchant wallet, like publishing. */
export async function removeListing(campaign: string, signMessage: (m: Uint8Array) => Promise<Uint8Array>): Promise<void> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signMessage(new TextEncoder().encode(`NOUX-UNLIST-v1|${campaign}|${ts}`));
  const r = await fetch(`${API_BASE}/campaigns/${campaign}/listing`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ ts, signature: btoa(String.fromCharCode(...sig)) }) });
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as any)?.error?.message ?? `HTTP ${r.status}`);
}
