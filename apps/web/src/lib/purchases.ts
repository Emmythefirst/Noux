// What this browser has bought through the buy page, so coming back to the page (or opening a receipt and returning) doesn't look like nothing
// happened and doesn't invite paying twice. Local to this device; the receipts themselves are public on-chain data.
export interface Purchase { campaign: string; buyer: string; sale?: string; tx?: string; at: number; referred: boolean }
const KEY = "noux.purchases";
const read = (): Purchase[] => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
export function purchasesFor(campaign: string, buyer: string): Purchase[] { return read().filter((p) => p.campaign === campaign && p.buyer === buyer).sort((a, b) => b.at - a.at); }
export function addPurchase(p: Purchase) { try { localStorage.setItem(KEY, JSON.stringify([p, ...read()].slice(0, 50))); } catch { /* storage may be blocked */ } }
