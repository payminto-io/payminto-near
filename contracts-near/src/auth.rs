//! Who may call what. Every entry point starts with exactly one guard from this file, and the guard returns a context
//! value that only this file can build, so a method body gets the verified caller from the guard and never from
//! `env::predecessor_account_id()` itself.
//!
//! | Role | Guard | Checks | Error codes |
//! |---|---|---|---|
//! | admin | `require_admin` | caller is the admin, at least 1 yoctoNEAR attached | `NOT_ADMIN`, `DEPOSIT_REQUIRED` |
//! | pending admin | `require_pending_admin` | caller was named by `propose_admin`, exactly 1 yoctoNEAR | `NOT_PENDING_ADMIN`, `ONE_YOCTO_REQUIRED` |
//! | owner | `require_owner` | the Budget exists and the caller owns it | `UNKNOWN_BUDGET`, `NOT_OWNER` |
//! | owner, full key | `require_owner_full_key` | as owner, and exactly 1 yoctoNEAR | as owner, `ONE_YOCTO_REQUIRED` |
//! | settler | `require_settler`, then `SettlerCtx::require_names` per Budget | caller is allowlisted, and is the Budget's settler | `NOT_SETTLER`, `NOT_BUDGET_SETTLER` |
//! | settler, full key | `require_settler_full_key` | as settler, and exactly 1 yoctoNEAR | `NOT_SETTLER`, `ONE_YOCTO_REQUIRED` |
//! | proposed checkout settler | `require_pending_checkout_settler` | caller is the settler `set_checkout_key` named, exactly 1 yoctoNEAR | `NOT_PENDING_CHECKOUT`, `ONE_YOCTO_REQUIRED` |
//! | payee | `require_payee` | caller is the claim's payee and not the Budget's owner | `NOT_PAYEE`, `PAYEE_IS_OWNER` |
//! | token | `token_caller` | caller is the token; anything else is refunded, never a panic | none |
//! | the hub itself | `require_self` | caller is the hub account: the callbacks and `new` | `NOT_SELF` |
//! | anyone, full key | `anyone_full_key` | exactly 1 yoctoNEAR; acts on the caller's own balance only | `ONE_YOCTO_REQUIRED` |
//! | anyone | `anyone` | nothing, by decision: `open_budget`, `payout`, `fund_storage` and every view | none |
//!
//! The "full key" guards require exactly one yoctoNEAR, which a function-call access key cannot attach, so only a
//! full-access key or a wallet confirmation can call those methods.

use near_sdk::{AccountId, NearToken, env, require};

use crate::Hub;
use crate::errors::*;
use crate::types::{Budget, Claim, Id32};

/// The caller is the admin and attached at least one yoctoNEAR.
pub struct AdminCtx {
    admin: AccountId,
}

/// The caller is the pending admin and attached exactly one yoctoNEAR.
pub struct PendingAdminCtx {
    account: AccountId,
}

/// The caller owns the Budget the guard loaded.
pub struct OwnerCtx {
    owner: AccountId,
}

/// The caller is on the settler allowlist.
pub struct SettlerCtx {
    settler: AccountId,
}

/// The caller is the payee of the claim and not the owner of its Budget.
pub struct PayeeCtx {
    payee: AccountId,
}

/// The caller is the token contract.
pub struct TokenCtx {
    _private: (),
}

/// The caller is the hub itself. `success` is the outcome of the one promise a callback waits for.
pub struct CallbackCtx {
    success: bool,
}

/// Any account, by decision.
pub struct AnyoneCtx {
    caller: AccountId,
}

impl AdminCtx {
    pub fn admin(&self) -> &AccountId {
        &self.admin
    }
}

impl PendingAdminCtx {
    pub fn account(&self) -> &AccountId {
        &self.account
    }
}

impl OwnerCtx {
    pub fn owner(&self) -> &AccountId {
        &self.owner
    }
}

impl SettlerCtx {
    pub fn settler(&self) -> &AccountId {
        &self.settler
    }

    /// The Budget names this settler as the only account that may settle it.
    pub fn require_names(&self, budget: &Budget) {
        require!(budget.settler == self.settler, NOT_BUDGET_SETTLER);
    }
}

impl PayeeCtx {
    pub fn payee(&self) -> &AccountId {
        &self.payee
    }
}

impl CallbackCtx {
    pub fn success(&self) -> bool {
        self.success
    }
}

impl AnyoneCtx {
    pub fn caller(&self) -> &AccountId {
        &self.caller
    }
}

fn caller() -> AccountId {
    env::predecessor_account_id()
}

fn require_one_yocto() {
    require!(
        env::attached_deposit() == NearToken::from_yoctonear(1),
        ONE_YOCTO_REQUIRED
    );
}

impl Hub {
    pub(crate) fn require_admin(&self) -> AdminCtx {
        let admin = caller();
        require!(admin == self.admin, NOT_ADMIN);
        require!(env::attached_deposit().as_yoctonear() >= 1, DEPOSIT_REQUIRED);
        AdminCtx { admin }
    }

    pub(crate) fn require_pending_admin(&self) -> PendingAdminCtx {
        let account = caller();
        require!(self.pending_admin.as_ref() == Some(&account), NOT_PENDING_ADMIN);
        require_one_yocto();
        PendingAdminCtx { account }
    }

    pub(crate) fn require_owner(&self, budget_id: &Id32) -> (OwnerCtx, Budget) {
        let budget = self.load_budget(budget_id);
        let owner = caller();
        require!(budget.owner == owner, NOT_OWNER);
        (OwnerCtx { owner }, budget)
    }

    pub(crate) fn require_owner_full_key(&self, budget_id: &Id32) -> (OwnerCtx, Budget) {
        let found = self.require_owner(budget_id);
        require_one_yocto();
        found
    }

    pub(crate) fn require_settler(&self) -> SettlerCtx {
        let settler = caller();
        require!(self.settlers.contains(&settler), NOT_SETTLER);
        SettlerCtx { settler }
    }

    pub(crate) fn require_settler_full_key(&self) -> SettlerCtx {
        let ctx = self.require_settler();
        require_one_yocto();
        ctx
    }

    pub(crate) fn require_pending_checkout_settler(&self) -> SettlerCtx {
        let settler = caller();
        require!(
            self.pending_checkout.as_ref().is_some_and(|c| c.settler == settler),
            NOT_PENDING_CHECKOUT
        );
        require_one_yocto();
        SettlerCtx { settler }
    }

    pub(crate) fn require_payee(&self, claim: &Claim, budget: &Budget) -> PayeeCtx {
        let payee = caller();
        require!(claim.payee == payee, NOT_PAYEE);
        require!(payee != budget.owner, PAYEE_IS_OWNER);
        PayeeCtx { payee }
    }

    /// `None` when the caller is not the token: `ft_on_transfer` then returns the whole amount.
    pub(crate) fn token_caller(&self) -> Option<TokenCtx> {
        (caller() == self.token).then_some(TokenCtx { _private: () })
    }

    /// The hub calling itself: a promise callback, or `new` in the deploy transaction.
    /// A callback waits for exactly one promise; any other count, which only a direct call could produce, counts as a
    /// failure, so the guard itself never panics on it.
    pub(crate) fn require_self() -> CallbackCtx {
        require!(caller() == env::current_account_id(), NOT_SELF);
        // `is_promise_success` panics with a library message on any other count, so the count is checked first.
        let success = env::promise_results_count() == 1 && near_sdk::is_promise_success();
        CallbackCtx { success }
    }

    pub(crate) fn anyone() -> AnyoneCtx {
        AnyoneCtx { caller: caller() }
    }

    pub(crate) fn anyone_full_key() -> AnyoneCtx {
        require_one_yocto();
        AnyoneCtx { caller: caller() }
    }
}
