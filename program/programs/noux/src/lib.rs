//! Noux: per-sale deposit accounts for x402 referral splits.
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
pub const MAX_HOLD_SECS: u32 = 600;

#[program]
pub mod noux {
    use super::*;

    /// One-time, upgrade-authority only. Creates the global config that fixes the protocol fee and its recipient.
    /// `admin` may be any key (keep it separate from the deploy wallet); it can later change the fee within MAX_FEE_BPS.
    pub fn init_config(ctx: Context<InitConfig>, admin: Pubkey, fee_owner: Pubkey, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, NouxError::BpsTooHigh);
        require!(
            upgrade_authority(&ctx.accounts.program_data.try_borrow_data()?) == Some(ctx.accounts.authority.key()),
            NouxError::NotUpgradeAuthority
        );
        let c = &mut ctx.accounts.config;
        c.admin = admin;
        c.fee_owner = fee_owner;
        c.fee_bps = fee_bps;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin only. Affects campaigns created AFTERWARDS: each campaign copies the fee at creation and keeps it.
    pub fn update_config(ctx: Context<UpdateConfig>, admin: Pubkey, fee_owner: Pubkey, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, NouxError::BpsTooHigh);
        let c = &mut ctx.accounts.config;
        c.admin = admin;
        c.fee_owner = fee_owner;
        c.fee_bps = fee_bps;
        Ok(())
    }

    /// The protocol fee and fee wallet are NOT arguments: they are copied from the global config, so a merchant cannot
    /// set them to zero or to their own wallet.
    pub fn create_campaign(
        ctx: Context<CreateCampaign>,
        campaign_id: u64,
        commission_bps: u16,
        commission_budget: u64,
        attribution_key: Pubkey,
        cluster: [u8; 8],
        hold_secs: u32,
    ) -> Result<()> {
        let fee_bps = ctx.accounts.config.fee_bps;
        require!(commission_bps <= MAX_COMMISSION_BPS, NouxError::BpsTooHigh);
        require!(hold_secs <= MAX_HOLD_SECS, NouxError::HoldTooLong);
        require!(commission_bps as u64 + fee_bps as u64 <= BPS, NouxError::BpsTooHigh);
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
        c.hold_secs = hold_secs;
        c.settled_count = 0;
        c.refunded_count = 0;
        c.fee_owner = ctx.accounts.config.fee_owner;
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
        require!(campaign_is_active(&ctx.accounts.control, ctx.program_id), NouxError::CampaignNotActive);
        let now = Clock::get()?.unix_timestamp;
        require!(now <= expiry, NouxError::ClaimExpired);
        require!(
            ctx.accounts.distributor.key() != ctx.accounts.buyer.key(),
            NouxError::SelfReferral
        );
        require!(price > 0, NouxError::ZeroPrice);

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
        s.hold_until = now + c.hold_secs as i64;
        s.bump = ctx.bumps.sale;
        // Terms frozen at open time so later campaign edits can't change this sale.
        s.commission_bps = c.commission_bps;
        s.fee_bps = c.fee_bps;
        Ok(())
    }

    /// Permissionless. Splits the sale account balance by the stored terms.
    pub fn settle_sale(ctx: Context<SettleSale>) -> Result<()> {
        let sale = &ctx.accounts.sale;
        require!(sale.status == SaleStatus::Open, NouxError::AlreadySettled);
        // Merchant (who has confirmed delivery) may settle immediately; everyone else waits out the hold.
        let is_merchant = ctx.accounts.caller.key() == ctx.accounts.campaign.merchant;
        require!(
            is_merchant || Clock::get()?.unix_timestamp >= sale.hold_until,
            NouxError::HoldActive
        );
        let amount = ctx.accounts.sale_vault.amount;
        require!(amount >= sale.price, NouxError::Underpaid);

        let c = &mut ctx.accounts.campaign;
        let Split { merchant: merchant_amt, commission, fee } =
            compute_split(amount, sale.fee_bps, sale.commission_bps, c.commission_budget, c.commission_spent).ok_or(NouxError::Math)?;
        c.commission_spent = c.commission_spent.checked_add(commission).ok_or(NouxError::Math)?;
        c.settled_count = c.settled_count.checked_add(1).ok_or(NouxError::Math)?;

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

    /// Merchant only, before settlement: returns the whole vault to the claim-bound buyer and pays
    /// no commission or fee. The sale stays on-chain as a `Refunded` receipt. After settlement it is final.
    pub fn refund_sale(ctx: Context<RefundSale>) -> Result<()> {
        let sale = &ctx.accounts.sale;
        require!(sale.status == SaleStatus::Open, NouxError::AlreadySettled);
        let amount = ctx.accounts.sale_vault.amount;
        require!(amount > 0, NouxError::NothingToRefund);
        let seeds: &[&[u8]] = &[b"sale", sale.campaign.as_ref(), sale.nonce.as_ref(), &[sale.bump]];
        let signer = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.sale_vault.to_account_info(),
                    to: ctx.accounts.buyer_ata.to_account_info(),
                    authority: ctx.accounts.sale.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.sale_vault.to_account_info(),
                destination: ctx.accounts.rent_payer.to_account_info(),
                authority: ctx.accounts.sale.to_account_info(),
            },
            signer,
        ))?;
        let c = &mut ctx.accounts.campaign;
        c.refunded_count = c.refunded_count.checked_add(1).ok_or(NouxError::Math)?;
        let s = &mut ctx.accounts.sale;
        s.status = SaleStatus::Refunded;
        s.gross = amount;
        s.settled_at = Clock::get()?.unix_timestamp;
        emit!(SaleRefunded { sale: s.key(), campaign: s.campaign, buyer: s.buyer, amount });
        Ok(())
    }

    /// Merchant only. Raises the commission budget (the CAP) by `amount`. Increase-only: lowering a cap would shrink the commission of sales that are
    /// already in flight, so there is deliberately no way to reduce it. Nothing is locked or moved; this only widens what the campaign may pay out.
    pub fn top_up_budget(ctx: Context<MerchantControl>, amount: u64) -> Result<()> {
        let c = &mut ctx.accounts.campaign;
        let new_budget = raised_budget(c.commission_budget, amount).ok_or(NouxError::BadBudgetIncrease)?;
        emit!(BudgetRaised { campaign: c.key(), old_budget: c.commission_budget, new_budget });
        c.commission_budget = new_budget;
        Ok(())
    }

    /// Merchant only. Changes which key the campaign trusts to sign claims. Takes effect at once: `open_sale` checks every claim against the key stored here,
    /// so claims signed by the old key stop working immediately (sales already open are unaffected and settle normally). This is how a merchant reacts to a leaked key.
    pub fn set_attribution_key(ctx: Context<MerchantControl>, new_key: Pubkey) -> Result<()> {
        require!(new_key != Pubkey::default(), NouxError::InvalidKey);
        let c = &mut ctx.accounts.campaign;
        emit!(AttributionKeyChanged { campaign: c.key(), old_key: c.attribution_key, new_key });
        c.attribution_key = new_key;
        Ok(())
    }

    /// Merchant only. Pauses, resumes or permanently ends a campaign's NEW referral sales. `open_sale` refuses unless the campaign is Active; sales already open keep
    /// settling and refunding normally, and buyers can still buy without a referral. Active and Paused can swap; anything can move to Ended; Ended is final.
    /// The control account is created the first time it is needed (the merchant pays its rent); campaigns that were never paused have none.
    pub fn set_campaign_state(ctx: Context<SetCampaignState>, state: CampaignState) -> Result<()> {
        let ctl = &mut ctx.accounts.control;
        if ctl.campaign == Pubkey::default() { ctl.campaign = ctx.accounts.campaign.key(); ctl.state = CampaignState::Active; ctl.bump = ctx.bumps.control; }
        require!(ctl.campaign == ctx.accounts.campaign.key(), NouxError::NotMerchant);
        let next = next_state(ctl.state, state).ok_or(NouxError::BadStateChange)?;
        emit!(CampaignStateChanged { campaign: ctl.campaign, old_state: ctl.state, new_state: next });
        ctl.state = next;
        Ok(())
    }

    /// Permissionless. Reclaims rent from a sale nobody paid, once its claim has expired.
    /// Only after expiry: a closed sale's nonce can then never be replayed (claim is dead).
    pub fn close_expired_sale(ctx: Context<CloseExpiredSale>) -> Result<()> {
        let sale = &ctx.accounts.sale;
        require!(sale.status == SaleStatus::Open, NouxError::AlreadySettled);
        require!(Clock::get()?.unix_timestamp > sale.expiry, NouxError::NotExpired);
        require!(ctx.accounts.sale_vault.amount == 0, NouxError::VaultNotEmpty);
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

/// ProgramData PDA of this program under the upgradeable loader.
pub fn programdata_address() -> Pubkey {
    Pubkey::find_program_address(&[crate::ID.as_ref()], &solana_sdk_ids::bpf_loader_upgradeable::ID).0
}

/// Upgrade authority from raw ProgramData bytes: u32 variant (3) | u64 slot | Option<Pubkey> (1 tag byte + 32).
pub fn upgrade_authority(d: &[u8]) -> Option<Pubkey> {
    if d.len() < 45 || u32::from_le_bytes(d[0..4].try_into().ok()?) != 3 || d[12] != 1 {
        return None;
    }
    Some(Pubkey::new_from_array(d[13..45].try_into().ok()?))
}

fn mul_bps(amount: u64, bps: u16) -> u64 {
    (amount as u128 * bps as u128 / BPS as u128) as u64
}

/// The three parts of a settled payment. They always sum to the amount paid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Split {
    pub merchant: u64,
    pub commission: u64,
    pub fee: u64,
}

/// The settlement arithmetic, pure so it can be tested exhaustively: fee and wanted commission are floored, commission is capped by
/// what is left of the campaign budget, and the merchant gets the remainder (so rounding dust goes to the merchant and the parts sum
/// exactly to `amount`). `None` only if fee + commission would exceed the amount (impossible for bps the program accepts).
pub fn compute_split(amount: u64, fee_bps: u16, commission_bps: u16, budget: u64, spent: u64) -> Option<Split> {
    let fee = mul_bps(amount, fee_bps);
    let wanted = mul_bps(amount, commission_bps);
    let commission = wanted.min(budget.saturating_sub(spent));
    let merchant = amount.checked_sub(fee)?.checked_sub(commission)?;
    Some(Split { merchant, commission, fee })
}

/// The state machine. Active and Paused swap; anything can become Ended; Ended never changes; "no change" is refused so a mistaken call is visible.
pub fn next_state(current: CampaignState, requested: CampaignState) -> Option<CampaignState> {
    use CampaignState::*;
    match (current, requested) {
        (Ended, _) => None,
        (Active, Paused) | (Paused, Active) => Some(requested),
        (Active, Ended) | (Paused, Ended) => Some(Ended),
        (Active, Active) | (Paused, Paused) => None,
    }
}

/// Reads a control account's state from raw account data: `Some(state byte)` for a well-formed CampaignControl, `None` when there is no such data.
/// Layout: 8-byte discriminator | campaign (32) | state (1) | bump (1). The state byte is the enum variant index (0 Active, 1 Paused, 2 Ended).
pub fn control_state_byte(data: &[u8]) -> Option<u8> {
    if data.len() < 8 + 32 + 1 || data[..8] != *CampaignControl::DISCRIMINATOR { return None; }
    Some(data[8 + 32])
}

/// Is this campaign accepting new referral sales? A control account that does not exist, or is not ours, means yes; anything but an explicit Active state means no.
pub fn campaign_is_active(control: &UncheckedAccount, program_id: &Pubkey) -> bool {
    if control.owner != program_id { return true; }
    match control.try_borrow_data() { Ok(d) => match control_state_byte(&d) { None => true, Some(b) => b == 0 }, Err(_) => false }
}

/// The budget after a top-up: strictly larger, and it must not wrap. `None` for a zero amount or an overflow.
pub fn raised_budget(current: u64, amount: u64) -> Option<u64> {
    if amount == 0 { return None; }
    current.checked_add(amount)
}

/// Domain-separated claim message: tag | program id | cluster | campaign | distributor |
/// buyer | expiry | price | nonce  (13 + 32 + 8 + 32*3 + 8 + 8 + 32 = 197 bytes).
pub const CLAIM_TAG: &[u8; 13] = b"NOUX-CLAIM-v1";
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
    require!(cur > 0, NouxError::BadSignatureIx);
    let ix = load_instruction_at_checked(cur - 1, ix_sysvar)?;
    require!(ix.program_id == ed25519_program::ID, NouxError::BadSignatureIx);
    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, NouxError::BadSignatureIx);
    let u16at = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]) as usize;
    let (sig_ix, pk_off, pk_ix, msg_off, msg_len, msg_ix) =
        (u16at(4), u16at(6), u16at(8), u16at(10), u16at(12), u16at(14));
    // all data must live inside this very instruction (u16::MAX == "current ix")
    let m = u16::MAX as usize;
    require!(sig_ix == m && pk_ix == m && msg_ix == m, NouxError::BadSignatureIx);
    require!(pk_off + 32 <= d.len() && msg_off + msg_len <= d.len(), NouxError::BadSignatureIx);
    require!(&d[pk_off..pk_off + 32] == signer.as_ref(), NouxError::WrongSigner);
    require!(&d[msg_off..msg_off + msg_len] == msg, NouxError::ClaimMismatch);
    Ok(())
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// Must be the program's upgrade authority: nobody else can create (or front-run) the config.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init, payer = authority, space = 8 + Config::INIT_SPACE,
        seeds = [b"config"], bump
    )]
    pub config: Account<'info, Config>,
    /// CHECK: the program's ProgramData account. Address is derived below and the upgrade authority is read by hand
    /// (deserialising `ProgramData` through Anchor adds ~87 KB to the program).
    #[account(address = programdata_address() @ NouxError::NotUpgradeAuthority)]
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(address = config.admin @ NouxError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct CreateCampaign<'info> {
    #[account(mut)]
    pub merchant: Signer<'info>,
    pub mint: Account<'info, Mint>,
    /// The only source of the protocol fee and fee wallet. PDA-checked, so a look-alike account is rejected.
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
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
    /// CHECK: the campaign's control account. Its address is fixed by the seeds, so no other account can stand in for it, and only this program can create data at
    /// that address. An account that does not exist (or is not owned by this program) means the campaign is Active: campaigns never paused need no control account.
    #[account(seeds = [b"control", campaign.key().as_ref()], bump)]
    pub control: UncheckedAccount<'info>,
}

#[derive(Accounts)]
/// merchant_ata / distributor_ata / fee_ata are `dup`: one wallet may hold several roles (a merchant referring its own
/// sale, or the fee wallet being a merchant). Without `dup` Anchor rejects the settle with ConstraintDuplicateMutableAccount.
pub struct SettleSale<'info> {
    pub caller: Signer<'info>,
    #[account(mut, address = sale.campaign)]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(mut, seeds = [b"sale", sale.campaign.as_ref(), sale.nonce.as_ref()], bump = sale.bump)]
    pub sale: Box<Account<'info, Sale>>,
    #[account(mut, associated_token::mint = campaign.mint, associated_token::authority = sale)]
    pub sale_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, dup, associated_token::mint = campaign.mint, associated_token::authority = campaign.merchant)]
    pub merchant_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, dup, associated_token::mint = campaign.mint, associated_token::authority = sale.distributor)]
    pub distributor_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, dup, associated_token::mint = campaign.mint, associated_token::authority = campaign.fee_owner)]
    pub fee_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: receives the vault's rent back; must be whoever paid it.
    #[account(mut, address = sale.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundSale<'info> {
    #[account(address = campaign.merchant)]
    pub merchant: Signer<'info>,
    #[account(mut, address = sale.campaign)]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(mut, seeds = [b"sale", sale.campaign.as_ref(), sale.nonce.as_ref()], bump = sale.bump)]
    pub sale: Box<Account<'info, Sale>>,
    #[account(mut, associated_token::mint = campaign.mint, associated_token::authority = sale)]
    pub sale_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = campaign.mint, associated_token::authority = sale.buyer)]
    pub buyer_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: receives the vault's rent back; must be whoever paid it.
    #[account(mut, address = sale.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Merchant-only changes to one campaign (budget top-up, attribution key rotation).
#[derive(Accounts)]
pub struct MerchantControl<'info> {
    #[account(address = campaign.merchant @ NouxError::NotMerchant)]
    pub merchant: Signer<'info>,
    #[account(mut)]
    pub campaign: Box<Account<'info, Campaign>>,
}

#[derive(Accounts)]
pub struct SetCampaignState<'info> {
    #[account(mut, address = campaign.merchant @ NouxError::NotMerchant)]
    pub merchant: Signer<'info>,
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(
        init_if_needed, payer = merchant, space = 8 + CampaignControl::INIT_SPACE,
        seeds = [b"control", campaign.key().as_ref()], bump
    )]
    pub control: Account<'info, CampaignControl>,
    pub system_program: Program<'info, System>,
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

/// Global, one per program. Fee % and fee wallet for NEW campaigns; capped at MAX_FEE_BPS.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub fee_owner: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
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
    /// Seconds after a sale is opened before ANYONE may settle it. The merchant can settle at once.
    pub hold_secs: u32,
    pub settled_count: u64,
    pub refunded_count: u64,
    pub campaign_id: u64,
    pub commission_budget: u64,
    pub commission_spent: u64,
    pub commission_bps: u16,
    pub fee_bps: u16,
    pub bump: u8,
}

/// Whether a campaign takes new referral sales. Lives in its own account so existing campaigns need no migration.
#[account]
#[derive(InitSpace)]
pub struct CampaignControl {
    pub campaign: Pubkey,
    pub state: CampaignState,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CampaignState {
    Active,
    Paused,
    Ended,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SaleStatus {
    Open,
    Settled,
    Refunded,
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
    pub hold_until: i64,
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
pub struct CampaignStateChanged {
    pub campaign: Pubkey,
    pub old_state: CampaignState,
    pub new_state: CampaignState,
}

#[event]
pub struct BudgetRaised {
    pub campaign: Pubkey,
    pub old_budget: u64,
    pub new_budget: u64,
}

#[event]
pub struct AttributionKeyChanged {
    pub campaign: Pubkey,
    pub old_key: Pubkey,
    pub new_key: Pubkey,
}

#[event]
pub struct SaleRefunded {
    pub sale: Pubkey,
    pub campaign: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
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
pub enum NouxError {
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
    #[msg("hold window still active; only the merchant can settle now")]
    HoldActive,
    #[msg("hold exceeds the maximum")]
    HoldTooLong,
    #[msg("sale vault is empty, nothing to refund")]
    NothingToRefund,
    #[msg("math overflow")]
    Math,
    #[msg("signer is not the program upgrade authority")]
    NotUpgradeAuthority,
    #[msg("signer is not the config admin")]
    NotAdmin,
    #[msg("signer is not the campaign merchant")]
    NotMerchant,
    #[msg("budget increase must be greater than zero and must not overflow")]
    BadBudgetIncrease,
    #[msg("attribution key must not be the all-zero key")]
    InvalidKey,
    #[msg("this campaign is paused or ended and takes no new referral sales")]
    CampaignNotActive,
    #[msg("that state change is not allowed (an ended campaign never changes; pausing a paused campaign is refused)")]
    BadStateChange,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tiny deterministic generator: no external crates, reproducible failures.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
        fn amount(&mut self) -> u64 {
            match self.next() % 6 {
                0 => self.next() % 20,
                1 => self.next() % 100_000,
                2 => self.next() % 1_000_000_000_000,
                3 => u64::MAX - self.next() % 1_000,
                _ => self.next(),
            }
        }
    }

    /// A different algorithm for floor(amount * bps / 10000) that never leaves u64: split the amount by 10000 first.
    fn reference_bps(amount: u64, bps: u16) -> u64 { (amount / 10_000) * bps as u64 + (amount % 10_000) * bps as u64 / 10_000 }

    #[test]
    fn worked_examples_match_the_docs() {
        // 100000 at 15% + 1%: 84000 / 15000 / 1000
        assert_eq!(compute_split(100_000, 100, 1500, 1_000_000, 0), Some(Split { merchant: 84_000, commission: 15_000, fee: 1_000 }));
        // 33333 (rounding): fee 333, commission 4999, merchant keeps the dust
        assert_eq!(compute_split(33_333, 100, 1500, 1_000_000, 0), Some(Split { merchant: 28_001, commission: 4_999, fee: 333 }));
        // 1 base unit: everything floors to zero, the merchant keeps it
        assert_eq!(compute_split(1, 100, 1500, 1_000_000, 0), Some(Split { merchant: 1, commission: 0, fee: 0 }));
        // budget cap: only 5000 left of the 15000 wanted
        assert_eq!(compute_split(100_000, 100, 1500, 20_000, 15_000), Some(Split { merchant: 94_000, commission: 5_000, fee: 1_000 }));
        // budget exhausted or overspent (spent > budget): no commission, no underflow
        assert_eq!(compute_split(100_000, 100, 1500, 20_000, 20_000), Some(Split { merchant: 99_000, commission: 0, fee: 1_000 }));
        assert_eq!(compute_split(100_000, 100, 1500, 20_000, u64::MAX), Some(Split { merchant: 99_000, commission: 0, fee: 1_000 }));
        // zero everything
        assert_eq!(compute_split(0, 100, 1500, 1, 0), Some(Split { merchant: 0, commission: 0, fee: 0 }));
    }

    #[test]
    fn floor_matches_an_independent_algorithm_everywhere() {
        let mut r = Rng(0x9E3779B97F4A7C15);
        for _ in 0..200_000 {
            let (a, bps) = (r.amount(), (r.next() % 10_001) as u16);
            assert_eq!(mul_bps(a, bps), reference_bps(a, bps), "amount {a} bps {bps}");
        }
        for a in [0, 1, 9_999, 10_000, 10_001, u64::MAX - 1, u64::MAX] { for bps in [0u16, 1, 100, 500, 1500, 5000, 5500, 10_000] { assert_eq!(mul_bps(a, bps), reference_bps(a, bps)); } }
    }

    #[test]
    fn the_parts_always_sum_to_the_amount_and_respect_every_rule() {
        let mut r = Rng(0xDEADBEEFCAFEF00D);
        for _ in 0..300_000 {
            let amount = r.amount();
            let (fee_bps, commission_bps) = ((r.next() % (MAX_FEE_BPS as u64 + 1)) as u16, (r.next() % (MAX_COMMISSION_BPS as u64 + 1)) as u16);
            let budget = if r.next() % 4 == 0 { r.next() % 50_000 } else { r.next() };
            let spent = match r.next() % 4 { 0 => 0, 1 => budget, 2 => r.next(), _ => r.next() % (budget.max(1)) };
            let s = compute_split(amount, fee_bps, commission_bps, budget, spent).expect("accepted bps can never exceed the amount");
            let ctx = format!("amount {amount} fee {fee_bps} comm {commission_bps} budget {budget} spent {spent} -> {s:?}");
            // 1. exact sum, in a wider type so the check itself cannot overflow
            assert_eq!(s.merchant as u128 + s.commission as u128 + s.fee as u128, amount as u128, "{ctx}");
            // 2. fee is exactly the floored fee
            assert_eq!(s.fee, reference_bps(amount, fee_bps), "{ctx}");
            // 3. commission never exceeds what was wanted nor what is left of the budget
            let wanted = reference_bps(amount, commission_bps);
            assert!(s.commission <= wanted && s.commission <= budget.saturating_sub(spent), "{ctx}");
            // 4. it is the minimum of the two (the cap only bites when it must)
            assert_eq!(s.commission, wanted.min(budget.saturating_sub(spent)), "{ctx}");
            // 5. the merchant never gets less than amount minus fee minus the wanted commission (dust only ever helps the merchant)
            assert!(s.merchant >= amount - s.fee - wanted, "{ctx}");
        }
    }

    #[test]
    fn many_sales_can_never_push_total_commission_past_the_budget() {
        let mut r = Rng(0x1234_5678_9ABC_DEF1);
        for _ in 0..2_000 {
            let budget = r.next() % 1_000_000;
            let (mut spent, commission_bps) = (0u64, (r.next() % 5001) as u16);
            for _ in 0..50 {
                let amount = r.next() % 5_000_000;
                let s = compute_split(amount, 100, commission_bps, budget, spent).unwrap();
                spent = spent.checked_add(s.commission).expect("spent must not overflow");
                assert!(spent <= budget, "spent {spent} > budget {budget}");
            }
        }
    }

    #[test]
    fn maximum_rates_leave_the_merchant_at_least_45_percent() {
        for amount in [1u64, 99, 100_000, u64::MAX] {
            let s = compute_split(amount, MAX_FEE_BPS, MAX_COMMISSION_BPS, u64::MAX, 0).unwrap();
            assert_eq!(s.merchant as u128 + s.commission as u128 + s.fee as u128, amount as u128);
            assert!(s.merchant as u128 * 100 >= amount as u128 * 45, "merchant share fell below 45% at max rates for {amount}");
        }
    }

    #[test]
    fn rates_the_program_refuses_are_the_only_way_to_fail() {
        // create_campaign requires commission_bps + fee_bps <= 10000; beyond that the split would not fit in the amount
        assert_eq!(compute_split(100, 10_000, 10_000, u64::MAX, 0), None);
        assert!(compute_split(100, 5_000, 5_000, u64::MAX, 0).is_some());
    }

    #[test]
    fn campaign_state_machine_is_exactly_the_documented_one() {
        use CampaignState::*;
        let all = [Active, Paused, Ended];
        for cur in all { for req in all {
            let want = match (cur, req) { (Ended, _) => None, (Active, Paused) | (Paused, Active) => Some(req), (_, Ended) => Some(Ended), _ => None };
            assert_eq!(next_state(cur, req), want, "{cur:?} -> {req:?}");
        } }
        assert_eq!(next_state(Ended, Active), None, "an ended campaign can never be revived");
        assert_eq!(next_state(Ended, Paused), None); assert_eq!(next_state(Ended, Ended), None);
        assert_eq!(next_state(Active, Active), None, "a no-op is refused so a mistaken call is visible");
    }

    #[test]
    fn control_state_is_read_from_the_documented_layout_and_nothing_else() {
        let mut d = vec![0u8; 8 + 32 + 1 + 1]; d[..8].copy_from_slice(CampaignControl::DISCRIMINATOR);
        for (b, want) in [(0u8, Some(0u8)), (1, Some(1)), (2, Some(2)), (7, Some(7))] { d[40] = b; assert_eq!(control_state_byte(&d), want); }
        assert_eq!(control_state_byte(&d[..40]), None, "truncated");
        let mut wrong = d.clone(); wrong[0] ^= 0xFF; assert_eq!(control_state_byte(&wrong), None, "another account type is not a control account");
        assert_eq!(control_state_byte(&[]), None);
        assert_eq!(CampaignControl::INIT_SPACE, 32 + 1 + 1, "layout the reader assumes: campaign | state | bump");
    }

    #[test]
    fn top_up_only_ever_increases_and_never_wraps() {
        assert_eq!(raised_budget(1_000, 500), Some(1_500));
        assert_eq!(raised_budget(0, 1), Some(1));
        assert_eq!(raised_budget(1_000, 0), None, "a zero top-up is refused, not silently accepted");
        assert_eq!(raised_budget(u64::MAX, 1), None, "overflow is refused");
        assert_eq!(raised_budget(u64::MAX - 5, 5), Some(u64::MAX));
        assert_eq!(raised_budget(u64::MAX - 5, 6), None);
        let mut r = Rng(0xABCDEF0123456789);
        for _ in 0..100_000 { let (c, a) = (r.next(), r.next()); if let Some(n) = raised_budget(c, a) { assert!(n > c, "{c} + {a} = {n} must be larger"); assert_eq!(n as u128, c as u128 + a as u128); } else { assert!(a == 0 || c.checked_add(a).is_none()); } }
    }

    #[test]
    fn claim_message_layout_is_197_bytes_in_the_documented_order() {
        let (pid, camp, dist, buyer) = (Pubkey::new_from_array([1; 32]), Pubkey::new_from_array([2; 32]), Pubkey::new_from_array([3; 32]), Pubkey::new_from_array([4; 32]));
        let m = claim_message(&pid, b"devnet\0\0", &camp, &dist, &buyer, 0x0102030405060708, 0x1112131415161718, &[9u8; 32]);
        assert_eq!(m.len(), 197);
        assert_eq!(&m[0..13], b"NOUX-CLAIM-v1");
        assert_eq!(&m[13..45], &[1u8; 32]); assert_eq!(&m[45..53], b"devnet\0\0");
        assert_eq!(&m[53..85], &[2u8; 32]); assert_eq!(&m[85..117], &[3u8; 32]); assert_eq!(&m[117..149], &[4u8; 32]);
        assert_eq!(&m[149..157], &0x0102030405060708i64.to_le_bytes()); assert_eq!(&m[157..165], &0x1112131415161718u64.to_le_bytes());
        assert_eq!(&m[165..197], &[9u8; 32]);
    }

    #[test]
    fn every_signed_field_changes_the_message() {
        let k = |b: u8| Pubkey::new_from_array([b; 32]);
        let base = claim_message(&k(1), b"devnet\0\0", &k(2), &k(3), &k(4), 10, 20, &[5u8; 32]);
        let variants = [
            claim_message(&k(9), b"devnet\0\0", &k(2), &k(3), &k(4), 10, 20, &[5u8; 32]), claim_message(&k(1), b"mainnet\0", &k(2), &k(3), &k(4), 10, 20, &[5u8; 32]),
            claim_message(&k(1), b"devnet\0\0", &k(9), &k(3), &k(4), 10, 20, &[5u8; 32]), claim_message(&k(1), b"devnet\0\0", &k(2), &k(9), &k(4), 10, 20, &[5u8; 32]),
            claim_message(&k(1), b"devnet\0\0", &k(2), &k(3), &k(9), 10, 20, &[5u8; 32]), claim_message(&k(1), b"devnet\0\0", &k(2), &k(3), &k(4), 11, 20, &[5u8; 32]),
            claim_message(&k(1), b"devnet\0\0", &k(2), &k(3), &k(4), 10, 21, &[5u8; 32]), claim_message(&k(1), b"devnet\0\0", &k(2), &k(3), &k(4), 10, 20, &[6u8; 32]),
        ];
        for (i, v) in variants.iter().enumerate() { assert_ne!(&base, v, "field {i} is not covered by the signature"); }
    }

    #[test]
    fn upgrade_authority_parser_accepts_only_the_exact_programdata_layout() {
        let auth = Pubkey::new_from_array([7; 32]);
        let mut d = vec![0u8; 45]; d[0..4].copy_from_slice(&3u32.to_le_bytes()); d[12] = 1; d[13..45].copy_from_slice(auth.as_ref());
        assert_eq!(upgrade_authority(&d), Some(auth));
        let mut revoked = d.clone(); revoked[12] = 0; assert_eq!(upgrade_authority(&revoked), None, "an immutable program has no authority");
        let mut wrong_variant = d.clone(); wrong_variant[0] = 2; assert_eq!(upgrade_authority(&wrong_variant), None);
        assert_eq!(upgrade_authority(&d[..44]), None, "truncated data");
        assert_eq!(upgrade_authority(&[]), None);
    }
}
