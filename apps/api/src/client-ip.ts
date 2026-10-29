/**
 * The client address behind trusted proxies. Each proxy APPENDS the address it saw to X-Forwarded-For, so the entries on the right were written by our own
 * infrastructure and the ones on the left can be anything the client chose. With `hops` trusted proxies in front of us, the real client is the hops-th entry from the right.
 * Taking the leftmost entry (the old behaviour) let a client pick its own identity per request and walk around the per-IP limits.
 */
const IP_LIKE = /^[0-9a-fA-F:.]{2,45}$/; // IPv4 or IPv6 text only: never an arbitrary string used as a map key

export function clientIpFrom(xff: string | undefined, hops: number, peer: string | undefined): string {
  const fallback = peer && IP_LIKE.test(peer) ? peer : "unknown";
  if (!xff || hops < 1) return fallback;
  const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < hops) return fallback; // the request did not pass through every proxy we expect: do not guess
  const ip = parts[parts.length - hops];
  return IP_LIKE.test(ip) ? ip : fallback;
}
