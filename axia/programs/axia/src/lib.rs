//! Axia spike: per-sale deposit accounts for x402 referral splits.
//!
//! Flow: gateway calls `open_sale` with an ed25519-signed, buyer-bound claim.
//! That creates a `Sale` PDA (claim terms stored on-chain) and its token account.
//! The buyer pays the sale's token account via x402 (`payTo` = Sale PDA).
//! Anyone then calls `settle_sale`, which splits the balance by the stored terms.
use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::{ed25519_program, sysvar::instructions as ix_sysvar_id};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("AC6AtoRALLszNGNLmHte2UXKzCqBYQKhPdtq5qs77nkL");

pub const BPS: u64 = 10_000;
pub const MAX_COMMISSION_BPS: u16 = 5_000;
pub const MAX_FEE_BPS: u16 = 500;

#[program]
pub mod axia {
    use super::*;

    pub fn create_campaign(
        ctx: Context<CreateCampaign>,
        campaign_id: u64,
        commission_bps: u16,
        fee_bps: u16,
        commission_budget: u64,
        attribution_key: Pubkey,
        cluster: [u8; 8],
    ) -> Result<()> {
        require!(commission_bps <= MAX_COMMISSION_BPS, AxiaError::BpsTooHigh);
        require!(fee_bps <= MAX_FEE_BPS, AxiaError::BpsTooHigh);
        require!(commission_bps as u64 + fee_bps as u64 <= BPS, AxiaError::BpsTooHigh);
        let c = &mut ctx.accounts.campaign;
        c.merchant = ctx.accounts.merchant.key();
        c.mint = ctx.accounts.mint.key();
        c.campaign_id = campaign_id;
        c.commission_bps = commission_bps;
        c.fee_bps = fee_bps;
        c.commission_budget = commission_budget;
        c.commission_spent = 0;
        c.attribution_key = attribution_key;
        c.cluster = cluster;
        c.fee_owner = ctx.accounts.fee_owner.key();
        c.bump = ctx.bumps.campaign;
        Ok(())
    }

    /// Accepts a signed claim and opens a per-sale deposit account.
    /// The preceding instruction must be an ed25519 verify over the claim message.
    pub fn open_sale(
        ctx: Context<OpenSale>,
        nonce: [u8; 32],
        expiry: i64,
        price: u64,
    ) -> Result<()> {
        let c = &ctx.accounts.campaign;
        let now = Clock::get()?.unix_timestamp;
        require!(now <= expiry, AxiaError::ClaimExpired);
        require!(
            ctx.accounts.distributor.key() != ctx.accounts.buyer.key(),
            AxiaError::SelfReferral
        );
        require!(price > 0, AxiaError::ZeroPrice);

        let msg = claim_message(
            ctx.program_id,
            &c.cluster,
            &ctx.accounts.campaign.key(),
            &ctx.accounts.distributor.key(),
            &ctx.accounts.buyer.key(),
            expiry,
            price,
            &nonce,
        );
        verify_ed25519_prev(&ctx.accounts.instructions, &c.attribution_key, &msg)?;

        let s = &mut ctx.accounts.sale;
        s.campaign = ctx.accounts.campaign.key();
        s.distributor = ctx.accounts.distributor.key();
        s.buyer = ctx.accounts.buyer.key();
        s.nonce = nonce;
        s.expiry = expiry;
        s.price = price;
        s.rent_payer = ctx.accounts.payer.key();
        s.status = SaleStatus::Open;
        s.opened_at = now;
        s.bump = ctx.bumps.sale;
        // Terms frozen at open time so later campaign edits can't change this sale.
        s.commission_bps = c.commission_bps;
        s.fee_bps = c.fee_bps;
        Ok(())
    }

    /// Permissionless. Splits the sale account balance by the stored terms.
    pub fn settle_sale(ctx: Context<SettleSale>) -> Result<()> {
        let sale = &ctx.accounts.sale;
        require!(sale.status == SaleStatus::Open, AxiaError::AlreadySettled);
        let amount = ctx.accounts.sale_vault.amount;
        require!(amount >= sale.price, AxiaError::Underpaid);

        let fee = mul_bps(amount, sale.fee_bps)?;
        let wanted = mul_bps(amount, sale.commission_bps)?;
        let c = &mut ctx.accounts.campaign;
        let remaining = c.commission_budget.saturating_sub(c.commission_spent);
        let commission = wanted.min(remaining);
        let merchant_amt = amount
            .checked_sub(fee)
            .and_then(|v| v.checked_sub(commission))
            .ok_or(AxiaError::Math)?; // remainder (rounding dust) goes to merchant
        c.commission_spent = c.commission_spent.checked_add(commission).ok_or(AxiaError::Math)?;

        let campaign_key = sale.campaign;
        let seeds: &[&[u8]] = &[b"sale", campaign_key.as_ref(), sale.nonce.as_ref(), &[sale.bump]];
        let signer = &[seeds];

        for (to, amt) in [
            (ctx.accounts.merchant_ata.to_account_info(), merchant_amt),
            (ctx.accounts.distributor_ata.to_account_info(), commission),
            (ctx.accounts.fee_ata.to_account_info(), fee),
        ] {
            if amt == 0 {
                continue;
            }
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.sale_vault.to_account_info(),
                        to,
                        authority: ctx.accounts.sale.to_account_info(),
                    },
                    signer,
                ),
                amt,
            )?;
        }
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.sale_vault.to_account_info(),
                destination: ctx.accounts.rent_payer.to_account_info(),
                authority: ctx.accounts.sale.to_account_info(),
            },
            signer,
        ))?;

        let s = &mut ctx.accounts.sale;
        s.status = SaleStatus::Settled;
        s.gross = amount;
        s.merchant_amount = merchant_amt;
        s.commission_amount = commission;
        s.fee_amount = fee;
        s.settled_at = Clock::get()?.unix_timestamp;
        emit!(SaleSettled {
            sale: s.key(),
            campaign: s.campaign,
            distributor: s.distributor,
            buyer: s.buyer,
            gross: amount,
            merchant_amount: merchant_amt,
            commission_amount: commission,
            fee_amount: fee,
        });
        Ok(())
    }

    /// Permissionless. Reclaims rent from a sale nobody paid, once its claim has expired.
    /// Only after expiry: a closed sale's nonce can then never be replayed (claim is dead).
    pub fn close_expired_sale(ctx: Context<CloseExpiredSale>) -> Result<()> {
        let sale = &ctx.accounts.sale;
        require!(sale.status == SaleStatus::Open, AxiaError::AlreadySettled);
        require!(Clock::get()?.unix_timestamp > sale.expiry, AxiaError::NotExpired);
        require!(ctx.accounts.sale_vault.amount == 0, AxiaError::VaultNotEmpty);
        let seeds: &[&[u8]] = &[b"sale", sale.campaign.as_ref(), sale.nonce.as_ref(), &[sale.bump]];
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.sale_vault.to_account_info(),
                destination: ctx.accounts.rent_payer.to_account_info(),
                authority: ctx.accounts.sale.to_account_info(),
            },
            &[seeds],
        ))?;
        Ok(())
    }
}

fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    Ok((amount as u128 * bps as u128 / BPS as u128) as u64)
}

/// Domain-separated claim message: tag | program id | cluster | campaign | distributor |
/// buyer | expiry | price | nonce  (13 + 32 + 8 + 32*3 + 8 + 8 + 32 = 197 bytes).
pub const CLAIM_TAG: &[u8; 13] = b"AXIA-CLAIM-v1";
pub fn claim_message(
    program_id: &Pubkey,
    cluster: &[u8; 8],
    campaign: &Pubkey,
    distributor: &Pubkey,
    buyer: &Pubkey,
    expiry: i64,
    price: u64,
    nonce: &[u8; 32],
) -> Vec<u8> {
    let mut m = Vec::with_capacity(197);
    m.extend_from_slice(CLAIM_TAG);
    m.extend_from_slice(program_id.as_ref());
    m.extend_from_slice(cluster);
    m.extend_from_slice(campaign.as_ref());
    m.extend_from_slice(distributor.as_ref());
    m.extend_from_slice(buyer.as_ref());
    m.extend_from_slice(&expiry.to_le_bytes());
    m.extend_from_slice(&price.to_le_bytes());
    m.extend_from_slice(nonce);
    m
}

/// The instruction directly before this one must be a self-contained ed25519
/// verification of exactly (`signer`, `msg`).
fn verify_ed25519_prev(ix_sysvar: &AccountInfo, signer: &Pubkey, msg: &[u8]) -> Result<()> {
    let cur = load_current_index_checked(ix_sysvar)? as usize;
    require!(cur > 0, AxiaError::BadSignatureIx);
    let ix = load_instruction_at_checked(cur - 1, ix_sysvar)?;
    require!(ix.program_id == ed25519_program::ID, AxiaError::BadSignatureIx);
    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, AxiaError::BadSignatureIx);
    let u16at = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]) as usize;
    let (sig_ix, pk_off, pk_ix, msg_off, msg_len, msg_ix) =
        (u16at(4), u16at(6), u16at(8), u16at(10), u16at(12), u16at(14));
    // all data must live inside this very instruction (u16::MAX == "current ix")
    let m = u16::MAX as usize;
    require!(sig_ix == m && pk_ix == m && msg_ix == m, AxiaError::BadSignatureIx);
    require!(pk_off + 32 <= d.len() && msg_off + msg_len <= d.len(), AxiaError::BadSignatureIx);
    require!(&d[pk_off..pk_off + 32] == signer.as_ref(), AxiaError::WrongSigner);
    require!(&d[msg_off..msg_off + msg_len] == msg, AxiaError::ClaimMismatch);
    Ok(())
}

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct CreateCampaign<'info> {
    #[account(mut)]
    pub merchant: Signer<'info>,
    pub mint: Account<'info, Mint>,
    /// CHECK: owner of the protocol-fee token account; only stored.
    pub fee_owner: UncheckedAccount<'info>,
    #[account(
        init, payer = merchant, space = 8 + Campaign::INIT_SPACE,
        seeds = [b"campaign", merchant.key().as_ref(), &campaign_id.to_le_bytes()], bump
    )]
    pub campaign: Account<'info, Campaign>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 32])]
pub struct OpenSale<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub campaign: Box<Account<'info, Campaign>>,
    /// CHECK: bound by the signed claim.
    pub distributor: UncheckedAccount<'info>,
    /// CHECK: bound by the signed claim.
    pub buyer: UncheckedAccount<'info>,
    #[account(address = campaign.mint)]
    pub mint: Box<Account<'info, Mint>>,
    // PDA seeded by the nonce: re-using a claim fails at `init` (replay protection).
    #[account(
        init, payer = payer, space = 8 + Sale::INIT_SPACE,
        seeds = [b"sale", campaign.key().as_ref(), nonce.as_ref()], bump
    )]
    pub sale: Box<Account<'info, Sale>>,
    #[account(
        init, payer = payer,
        associated_token::mint = mint, associated_token::authority = sale
    )]
    pub sale_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: instructions sysvar
    #[account(address = ix_sysvar_id::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleSale<'info> {
    #[account(mut, address = sale.campaign)]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(mut, seeds = [b"sale", sale.campaign.as_ref(), sale.nonce.as_ref()], bump = sale.bump)]
    pub sale: Box<Account<'info, Sale>>,
    #[account(mut, associated_token::mint = campaign.mint, associated_token::authority = sale)]
    pub sale_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = campaign.mint, associated_token::authority = campaign.merchant)]
    pub merchant_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = campaign.mint, associated_token::authority = sale.distributor)]
    pub distributor_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = campaign.mint, associated_token::authority = campaign.fee_owner)]
    pub fee_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: receives the vault's rent back; must be whoever paid it.
    #[account(mut, address = sale.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseExpiredSale<'info> {
    #[account(
        mut, close = rent_payer,
        seeds = [b"sale", sale.campaign.as_ref(), sale.nonce.as_ref()], bump = sale.bump
    )]
    pub sale: Box<Account<'info, Sale>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = sale)]
    pub sale_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = campaign.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(address = sale.campaign)]
    pub campaign: Box<Account<'info, Campaign>>,
    /// CHECK: receives the rent back; must be whoever paid it.
    #[account(mut, address = sale.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub fee_owner: Pubkey,
    pub attribution_key: Pubkey,
    /// Cluster tag (e.g. b"devnet\0\0"); part of the signed claim so claims can't cross clusters.
    pub cluster: [u8; 8],
    pub campaign_id: u64,
    pub commission_budget: u64,
    pub commission_spent: u64,
    pub commission_bps: u16,
    pub fee_bps: u16,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SaleStatus {
    Open,
    Settled,
}

/// Doubles as the public receipt once settled.
#[account]
#[derive(InitSpace)]
pub struct Sale {
    pub campaign: Pubkey,
    pub distributor: Pubkey,
    pub buyer: Pubkey,
    pub rent_payer: Pubkey,
    pub nonce: [u8; 32],
    pub expiry: i64,
    pub opened_at: i64,
    pub settled_at: i64,
    pub price: u64,
    pub gross: u64,
    pub merchant_amount: u64,
    pub commission_amount: u64,
    pub fee_amount: u64,
    pub commission_bps: u16,
    pub fee_bps: u16,
    pub status: SaleStatus,
    pub bump: u8,
}

#[event]
pub struct SaleSettled {
    pub sale: Pubkey,
    pub campaign: Pubkey,
    pub distributor: Pubkey,
    pub buyer: Pubkey,
    pub gross: u64,
    pub merchant_amount: u64,
    pub commission_amount: u64,
    pub fee_amount: u64,
}

#[error_code]
pub enum AxiaError {
    #[msg("bps out of range")]
    BpsTooHigh,
    #[msg("claim expired")]
    ClaimExpired,
    #[msg("distributor cannot be the buyer")]
    SelfReferral,
    #[msg("price must be > 0")]
    ZeroPrice,
    #[msg("preceding instruction is not a valid ed25519 verify")]
    BadSignatureIx,
    #[msg("claim not signed by the campaign attribution key")]
    WrongSigner,
    #[msg("signed message does not match the claim")]
    ClaimMismatch,
    #[msg("sale already settled")]
    AlreadySettled,
    #[msg("sale vault holds less than the price")]
    Underpaid,
    #[msg("claim has not expired yet")]
    NotExpired,
    #[msg("sale vault still holds funds; settle it instead")]
    VaultNotEmpty,
    #[msg("math overflow")]
    Math,
}
