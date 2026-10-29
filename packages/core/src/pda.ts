import { PublicKey } from "@solana/web3.js";

export function campaignPda(programId: PublicKey, merchant: PublicKey, campaignId: bigint): PublicKey {
  const id = Buffer.alloc(8); id.writeBigUInt64LE(campaignId);
  return PublicKey.findProgramAddressSync([Buffer.from("campaign"), merchant.toBuffer(), id], programId)[0];
}
export function salePda(programId: PublicKey, campaign: PublicKey, nonce: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("sale"), campaign.toBuffer(), Buffer.from(nonce)], programId)[0];
}
/** Global protocol config (fee % and fee wallet for new campaigns). One per program. */
/** The campaign's control account (pause / end). It may not exist: a campaign that was never paused has none, which means Active. */
export function controlPda(programId: PublicKey, campaign: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("control"), campaign.toBuffer()], programId)[0];
}

export function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}
