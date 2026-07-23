//! `X402SettlementToken` — a wrapped-CSPR CEP-18 token with CEP-3009 (`transfer_with_authorization`)
//! for x402 settlement, composed from `odra-modules`' official `Cep18` and `CEP3009` modules —
//! not a hand-rolled token or hand-rolled EIP-712. Same composition shape as the Odra team's own
//! `odradev/wcspr` reference (`Cep18` submodule for the ledger + deposit/withdraw against native
//! CSPR, `CEP3009` submodule delegated in for the EIP-712-signed authorization entry points),
//! written independently against the same two upstream modules — see
//! `docs/rfc/2026-07-21-x402-casper-eip712-interop.md` §5.0 for the full research trail this is
//! built from.
//!
//! Depositing native CSPR mints an equal amount of this token 1:1 (9 decimals, matching CSPR's
//! own); withdrawing burns it and returns native CSPR. `transfer_with_authorization` lets a
//! holder authorize a transfer via an off-chain EIP-712 signature that any relayer — KARMA's own
//! x402 settlement path, or the recipient themselves — submits on-chain, no separate `approve`
//! transaction needed. This is the real CEP-18 asset `x402_casper.ts`'s `asset` field will point
//! at once the TypeScript side is cut over (RFC §5.1-§5.5).

use odra::casper_types::bytesrepr::Bytes;
use odra::casper_types::{PublicKey, U256};
use odra::prelude::*;
use odra::uints::{ToU256, ToU512};
use odra::ContractRef;
use odra_modules::cep18_token::Cep18;
use odra_modules::cep3009::CEP3009;
use odra_modules::wrapped_native::CsprDepositContractRef;

pub const TOKEN_NAME: &str = "KARMA x402 Settlement Token";
pub const TOKEN_SYMBOL: &str = "KX402";
pub const TOKEN_DECIMALS: u8 = 9; // matches CSPR's own decimals — 1 token unit = 1 mote

/// Emitted when native CSPR is wrapped into the settlement token.
#[odra::event]
pub struct Deposited {
    pub account: Address,
    pub value: U256,
}

/// Emitted when the settlement token is unwrapped back to native CSPR.
#[odra::event]
pub struct Withdrawn {
    pub account: Address,
    pub value: U256,
}

/// CEP-18 ledger (`Cep18`) + CEP-3009 authorization transfers (`CEP3009`), deposit/withdraw
/// against native CSPR.
#[odra::module(events = [Deposited, Withdrawn])]
pub struct X402SettlementToken {
    token: SubModule<Cep18>,
    cep3009: SubModule<CEP3009>,
}

#[odra::module]
impl X402SettlementToken {
    /// Initializes the CEP-18 ledger (zero initial supply — minted only via `deposit`) and the
    /// CEP-3009 EIP-712 domain. `chain_name` (e.g. `"casper-test"`) binds every signed
    /// authorization to this network, so a Testnet-signed payload can never replay on Mainnet.
    pub fn init(&mut self, chain_name: String) {
        self.token.init(TOKEN_SYMBOL.to_string(), TOKEN_NAME.to_string(), TOKEN_DECIMALS, U256::zero());
        self.cep3009.init(chain_name);
    }

    /// Wraps attached native CSPR 1:1 into the settlement token.
    #[odra(payable)]
    pub fn deposit(&mut self) {
        let caller = self.env().caller();
        let amount = self.env().attached_value().to_u256().unwrap_or_revert(self);
        self.token.raw_mint(&caller, &amount);
        self.env().emit_event(Deposited { account: caller, value: amount });
    }

    /// Unwraps the caller's settlement token back to native CSPR. Contract recipients (rare for
    /// an x402 payer, but not disallowed) go through `CsprDepositContractRef`'s `deposit` entry
    /// point — a plain purse transfer to a contract address is not a valid Casper operation.
    pub fn withdraw(&mut self, amount: &U256) {
        let caller = self.env().caller();
        self.token.raw_burn(&caller, amount);
        let motes = amount.to_u512();
        if caller.is_contract() {
            CsprDepositContractRef::new(self.env(), caller).with_tokens(motes).deposit();
        } else {
            self.env().transfer_tokens(&caller, &motes);
        }
        self.env().emit_event(Withdrawn { account: caller, value: *amount });
    }

    delegate! {
        to self.token {
            fn name(&self) -> String;
            fn symbol(&self) -> String;
            fn decimals(&self) -> u8;
            fn total_supply(&self) -> U256;
            fn balance_of(&self, address: &Address) -> U256;
            fn allowance(&self, owner: &Address, spender: &Address) -> U256;
            fn approve(&mut self, spender: &Address, amount: &U256);
            fn transfer(&mut self, recipient: &Address, amount: &U256);
            fn transfer_from(&mut self, owner: &Address, recipient: &Address, amount: &U256);
        }

        to self.cep3009 {
            fn authorization_state(&self, authorizer: Address, nonce: Bytes) -> bool;
            fn transfer_with_authorization(
                &mut self,
                from: Address,
                to: Address,
                value: U256,
                valid_after: u64,
                valid_before: u64,
                nonce: Bytes,
                public_key: PublicKey,
                signature: Bytes,
            );
            fn receive_with_authorization(
                &mut self,
                from: Address,
                to: Address,
                value: U256,
                valid_after: u64,
                valid_before: u64,
                nonce: Bytes,
                public_key: PublicKey,
                signature: Bytes,
            );
            fn cancel_authorization(
                &mut self,
                authorizer: Address,
                nonce: Bytes,
                public_key: PublicKey,
                signature: Bytes,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::casper_types::U512;
    use odra::host::{Deployer, HostEnv, HostRef};

    fn setup() -> (HostEnv, X402SettlementTokenHostRef) {
        let env = odra_test::env();
        let init_args = X402SettlementTokenInitArgs { chain_name: "casper-test".to_string() };
        let contract = X402SettlementToken::deploy(&env, init_args);
        (env, contract)
    }

    #[test]
    fn deposit_mints_1to1_and_withdraw_burns_1to1() {
        let (env, mut token) = setup();
        let alice = env.get_account(0);
        env.set_caller(alice);

        token.with_tokens(U512::from(1_000_000_000u64)).deposit(); // 1 CSPR in motes
        assert_eq!(token.balance_of(&alice), U256::from(1_000_000_000u64));
        assert_eq!(token.total_supply(), U256::from(1_000_000_000u64));

        token.withdraw(&U256::from(400_000_000u64));
        assert_eq!(token.balance_of(&alice), U256::from(600_000_000u64));
        assert_eq!(token.total_supply(), U256::from(600_000_000u64));
    }

    #[test]
    fn plain_transfer_still_works_alongside_cep3009() {
        let (env, mut token) = setup();
        let alice = env.get_account(0);
        let bob = env.get_account(1);
        env.set_caller(alice);

        token.with_tokens(U512::from(1_000_000_000u64)).deposit();
        token.transfer(&bob, &U256::from(250_000_000u64));

        assert_eq!(token.balance_of(&alice), U256::from(750_000_000u64));
        assert_eq!(token.balance_of(&bob), U256::from(250_000_000u64));
    }

    #[test]
    fn fresh_authorization_state_is_unused() {
        let (env, token) = setup();
        let alice = env.get_account(0);
        let nonce = Bytes::from(vec![0u8; 32]);
        assert!(!token.authorization_state(alice, nonce));
    }
}
