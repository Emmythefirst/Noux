import { useCallback, useState } from "react";

// No wallet connection yet. The wallet address is a plain public key the visitor types in: it is their
// referral ID and the address we read their earnings for. Nothing is signed and nothing leaves the browser
// except the public API reads. Kept in localStorage purely as a convenience; every access is wrapped.
const KEY = "noux.wallet";
export const isPubkey = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

function read(): string {
  try { const v = localStorage.getItem(KEY) ?? ""; return isPubkey(v) ? v : ""; } catch { return ""; }
}

export function useWalletAddress(): [string, (v: string) => void] {
  const [v, setV] = useState(read);
  const set = useCallback((next: string) => {
    setV(next);
    try { if (isPubkey(next)) localStorage.setItem(KEY, next); else if (next === "") localStorage.removeItem(KEY); } catch { /* storage may be blocked */ }
  }, []);
  return [v, set];
}
