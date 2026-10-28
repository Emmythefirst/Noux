/** Kept apart from program.ts so pages that only need the chain id don't pull in the Solana library. */
export const CHAIN = ((import.meta.env.VITE_CHAIN as string | undefined) ?? "solana:devnet") as `${string}:${string}`;
