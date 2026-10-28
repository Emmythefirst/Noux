import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { SolanaSignMessageFeature, SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import type { Transaction } from "@solana/web3.js";
import { CHAIN } from "./chain";
import { RPC_URL } from "./verify";

// Wallet Standard: any wallet that registers itself (Phantom, Solflare, Backpack, ...) shows up here. No per-wallet code.
const LAST = "noux.lastWallet";
const storage = {
  get: () => { try { return localStorage.getItem(LAST); } catch { return null; } },
  set: (v: string | null) => { try { v ? localStorage.setItem(LAST, v) : localStorage.removeItem(LAST); } catch { /* storage may be blocked */ } },
};

type Feat = Wallet["features"];
const can = (w: Wallet) => "solana:signTransaction" in w.features && "standard:connect" in w.features && w.chains.some((c) => c.startsWith("solana:"));

export interface WalletCtx {
  wallets: Wallet[];
  address: string | null;
  walletName: string | null;
  connecting: boolean;
  error: string | null;
  connect: (w: Wallet) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Signs, sends and confirms. Returns the signature. Throws with a readable message (including "rejected"). */
  signAndSend: (tx: Transaction) => Promise<string>;
  signMessage: (msg: Uint8Array) => Promise<Uint8Array>;
}
const Ctx = createContext<WalletCtx | null>(null);
export const useWallet = () => { const c = useContext(Ctx); if (!c) throw new Error("WalletProvider missing"); return c; };

const friendly = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  return /reject|denied|cancel|declin/i.test(m) ? "You rejected the request in your wallet." : m;
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [account, setAccount] = useState<{ wallet: Wallet; account: WalletAccount } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = getWallets();
    const sync = () => setWallets(api.get().filter(can));
    sync();
    const off = [api.on("register", sync), api.on("unregister", sync)];
    return () => off.forEach((f) => f());
  }, []);

  const doConnect = useCallback(async (w: Wallet, silent: boolean) => {
    setConnecting(true); setError(null);
    try {
      const feat = (w.features as Feat)["standard:connect"] as { connect(i?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
      const { accounts } = await feat.connect({ silent });
      const a = accounts.find((x) => x.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
      if (!a) throw new Error("The wallet returned no account.");
      setAccount({ wallet: w, account: a }); storage.set(w.name);
    } catch (e) { if (!silent) setError(friendly(e)); }
    finally { setConnecting(false); }
  }, []);

  // reconnect quietly to the last wallet, if it is still installed and still trusts this site
  useEffect(() => {
    if (account) return;
    const last = storage.get(); const w = last ? wallets.find((x) => x.name === last) : undefined;
    if (w) void doConnect(w, true);
  }, [wallets, account, doConnect]);

  // follow account changes made inside the wallet
  useEffect(() => {
    if (!account) return;
    const ev = (account.wallet.features as Feat)["standard:events"] as { on(e: "change", cb: (p: { accounts?: readonly WalletAccount[] }) => void): () => void } | undefined;
    return ev?.on("change", (p) => { if (p.accounts) { const a = p.accounts[0]; if (a) setAccount({ wallet: account.wallet, account: a }); else { setAccount(null); storage.set(null); } } });
  }, [account]);

  const disconnect = useCallback(async () => {
    const w = account?.wallet; setAccount(null); storage.set(null);
    try { await ((w?.features as Feat | undefined)?.["standard:disconnect"] as { disconnect(): Promise<void> } | undefined)?.disconnect(); } catch { /* already gone */ }
  }, [account]);

  const signAndSend = useCallback(async (tx: Transaction) => {
    if (!account) throw new Error("Connect a wallet first.");
    try {
      const f = (account.wallet.features as Feat)["solana:signTransaction"] as SolanaSignTransactionFeature["solana:signTransaction"];
      const [out] = await f.signTransaction({ account: account.account, transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }), chain: CHAIN });
      const { Connection } = await import("@solana/web3.js"); // loaded on first use: keeps the web3 library out of the landing bundle
      const rpc = new Connection(RPC_URL, "confirmed");
      const sig = await rpc.sendRawTransaction(out.signedTransaction, { skipPreflight: false });
      const bh = tx.recentBlockhash!;
      const lastValid = (await rpc.getLatestBlockhash("confirmed")).lastValidBlockHeight;
      const res = await rpc.confirmTransaction({ signature: sig, blockhash: bh, lastValidBlockHeight: lastValid }, "confirmed");
      if (res.value.err) throw new Error("The transaction failed on-chain: " + JSON.stringify(res.value.err));
      return sig;
    } catch (e) { throw new Error(friendly(e)); }
  }, [account]);

  const signMessage = useCallback(async (msg: Uint8Array) => {
    if (!account) throw new Error("Connect a wallet first.");
    const f = (account.wallet.features as Feat)["solana:signMessage"] as SolanaSignMessageFeature["solana:signMessage"] | undefined;
    if (!f) throw new Error("This wallet can’t sign messages.");
    try { const [out] = await f.signMessage({ account: account.account, message: msg }); return out.signature; } catch (e) { throw new Error(friendly(e)); }
  }, [account]);

  const value = useMemo<WalletCtx>(() => ({
    wallets, address: account ? account.account.address : null, walletName: account?.wallet.name ?? null,
    connecting, error, connect: (w) => doConnect(w, false), disconnect, signAndSend, signMessage,
  }), [wallets, account, connecting, error, doConnect, disconnect, signAndSend, signMessage]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const getBlockhash = async () => {
  const { Connection } = await import("@solana/web3.js");
  return (await new Connection(RPC_URL, "confirmed").getLatestBlockhash("confirmed")).blockhash;
};
