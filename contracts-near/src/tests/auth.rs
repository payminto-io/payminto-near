//! The authorization matrix, generated from the guards: every public method is called as every wrong caller, with
//! the deposit the right caller would attach, and must refuse with exactly the guard's code. A method with no guard
//! must be listed as open to anyone, and a source scan fails the test when a public method is in neither list.

use super::*;

const STRANGER: &str = "stranger.test";
const NODE2: &str = "node2.test";

#[derive(Clone, Copy, Debug, PartialEq)]
enum Role {
    Admin,
    Owner,
    Settler,
    OtherSettler,
    Payee,
    Token,
    Hub,
    Stranger,
}

const ROLES: [Role; 8] = [
    Role::Admin,
    Role::Owner,
    Role::Settler,
    Role::OtherSettler,
    Role::Payee,
    Role::Token,
    Role::Hub,
    Role::Stranger,
];

fn account(role: Role) -> AccountId {
    match role {
        Role::Admin => admin(),
        Role::Owner => acct(A),
        Role::Settler => node(),
        Role::OtherSettler => acct(NODE2),
        Role::Payee => acct(S),
        Role::Token => token(),
        Role::Hub => hub_id(),
        Role::Stranger => acct(STRANGER),
    }
}

/// A hub with a second allowlisted settler, and a funded Budget of `A` whose settler is the node.
fn world() -> (Harness, Id32, SigningKey) {
    let mut h = Harness::new();
    h.ctx(admin(), plenty());
    h.hub.set_settler(acct(NODE2), true);
    h.ctx(acct("anyone.test"), plenty());
    h.hub.fund_storage(acct(NODE2));
    let key = agent(1);
    let a = h.open_simple(A, &key, 1000);
    h.deposit(A, &a, 100);
    (h, a, key)
}

type Call = Box<dyn Fn(&mut Harness, AccountId, &Id32, &SigningKey)>;

/// Every guarded method: the roles allowed to call it, the code every other role gets, and the call itself.
fn guarded() -> Vec<(&'static str, Vec<Role>, &'static str, Call)> {
    vec![
        (
            "new",
            vec![Role::Hub],
            NOT_SELF,
            Box::new(|h, who, _, _| {
                h.ctx(who, 0);
                let _ = Hub::new(admin(), token(), NET.to_string());
            }),
        ),
        (
            "revoke_budget",
            vec![Role::Owner],
            NOT_OWNER,
            Box::new(|h, who, a, _| {
                h.ctx(who, 0);
                h.hub.revoke_budget(*a);
            }),
        ),
        (
            "reclaim",
            vec![Role::Owner],
            NOT_OWNER,
            Box::new(|h, who, a, _| {
                h.ctx(who, 0);
                h.hub.reclaim(*a);
            }),
        ),
        (
            "prune",
            vec![Role::Owner],
            NOT_OWNER,
            Box::new(|h, who, a, _| {
                h.ctx(who, 0);
                h.hub.prune(*a, vec![acct(S)]);
            }),
        ),
        (
            "fund_from_credit",
            vec![Role::Owner],
            NOT_OWNER,
            Box::new(|h, who, a, _| {
                h.ctx(who, 1);
                h.hub.fund_from_credit(*a, U128(1));
            }),
        ),
        (
            "settle_batch",
            vec![Role::Settler, Role::OtherSettler],
            NOT_SETTLER,
            Box::new(|h, who, a, key| {
                h.ctx(who, 0);
                h.hub
                    .settle_batch(id(1), id(0xee), vec![claim(a, S, key, 1, 1)], entries(&[(A, S, 1)]));
            }),
        ),
        (
            "settle_own",
            vec![Role::Payee],
            NOT_PAYEE,
            Box::new(|h, who, a, key| {
                let c = claim(a, S, key, 1, 1);
                let accepted = h.accept(&c);
                h.ctx(who, 0);
                h.hub.settle_own(c, accepted);
            }),
        ),
        (
            "on_payout",
            vec![Role::Hub],
            NOT_SELF,
            Box::new(|h, who, _, _| {
                h.ctx_full(who, 0, Gas::from_tgas(10), vec![PromiseResult::Failed]);
                h.hub.on_payout(acct(S), U128(1));
            }),
        ),
        (
            "on_reclaim",
            vec![Role::Hub],
            NOT_SELF,
            Box::new(|h, who, a, _| {
                h.ctx_full(who, 0, Gas::from_tgas(10), vec![PromiseResult::Failed]);
                h.hub.on_reclaim(*a, U128(1));
            }),
        ),
        (
            "set_settler",
            vec![Role::Admin],
            NOT_ADMIN,
            Box::new(|h, who, _, _| {
                h.ctx(who, plenty());
                h.hub.set_settler(acct("new-node.test"), true);
            }),
        ),
        (
            "set_checkout_key",
            vec![Role::Admin],
            NOT_ADMIN,
            Box::new(|h, who, _, _| {
                h.ctx(who, plenty());
                h.hub.set_checkout_key(pk(&agent(9)), node());
            }),
        ),
        (
            "propose_admin",
            vec![Role::Admin],
            NOT_ADMIN,
            Box::new(|h, who, _, _| {
                h.ctx(who, plenty());
                h.hub.propose_admin(Some(acct("next-admin.test")));
            }),
        ),
        (
            // Nobody is pending, so every role is wrong, the admin included.
            "accept_admin",
            vec![],
            NOT_PENDING_ADMIN,
            Box::new(|h, who, _, _| {
                h.ctx(who, 1);
                h.hub.accept_admin();
            }),
        ),
        (
            // Nothing is proposed, so every role is wrong, the settlers included.
            "accept_checkout",
            vec![],
            NOT_PENDING_CHECKOUT,
            Box::new(|h, who, _, _| {
                h.ctx(who, 1);
                h.hub.accept_checkout(pk(&agent(9)));
            }),
        ),
        (
            "set_min_payment",
            vec![Role::Admin],
            NOT_ADMIN,
            Box::new(|h, who, _, _| {
                h.ctx(who, 1);
                h.hub.set_min_payment(U128(5));
            }),
        ),
        (
            "register_receipt_key",
            vec![Role::Settler, Role::OtherSettler],
            NOT_SETTLER,
            Box::new(|h, who, _, _| {
                h.ctx(who, 1);
                h.hub.register_receipt_key(pk(&agent(9)));
            }),
        ),
    ]
}

/// Methods anyone may call, by decision. `ft_on_transfer` is here because it never panics on a wrong caller: it
/// refunds, which `token_receiver_refunds_every_caller_but_the_token` checks.
const ANYONE: &[&str] = &[
    "open_budget",
    "ft_on_transfer",
    "payout",
    "fund_storage",
    "withdraw_storage",
    "budget",
    "settled_of",
    "credit_of",
    "receipt_keys",
    "storage_of",
    "batch",
    "payments",
    "is_settler",
    "checkout_key",
    "checkout_settler",
    "pending_checkout",
    "totals",
    "config",
    "verify_receipt",
];

#[test]
fn every_guarded_method_refuses_every_wrong_caller_with_its_exact_code() {
    let (mut h, a, key) = world();
    let mut checked = 0;
    for (method, allowed, code, call) in guarded() {
        for role in ROLES {
            if allowed.contains(&role) {
                continue;
            }
            let message = h.panic_message(|h| call(h, account(role), &a, &key));
            assert_eq!(
                message.as_deref(),
                Some(code),
                "{method} called by {role:?} must refuse with {code}"
            );
            checked += 1;
        }
    }
    assert!(checked > 80, "{checked} refusals checked");
}

#[test]
fn the_allowed_caller_passes_each_guard() {
    // Each allowed role gets past the guard: whatever it hits next is not the guard's code.
    let (mut h, a, key) = world();
    for (method, allowed, code, call) in guarded() {
        for role in allowed {
            let message = h.panic_message(|h| call(h, account(role), &a, &key));
            assert_ne!(message.as_deref(), Some(code), "{method} refused its own {role:?}");
        }
    }
}

#[test]
fn the_other_settler_is_refused_by_the_budget_and_the_owner_by_settle_own() {
    let (mut h, a, key) = world();
    h.expect_code(NOT_BUDGET_SETTLER, |h| {
        h.ctx(acct(NODE2), 0);
        h.hub
            .settle_batch(id(1), id(0xee), vec![claim(&a, S, &key, 1, 1)], entries(&[(A, S, 1)]));
    });
    let to_owner = claim(&a, A, &key, 1, 1);
    let accepted = h.accept(&to_owner);
    h.expect_code(PAYEE_IS_OWNER, |h| {
        h.ctx(acct(A), 0);
        h.hub.settle_own(to_owner, accepted);
    });
}

#[test]
fn token_receiver_refunds_every_caller_but_the_token() {
    let (mut h, a, _) = world();
    for role in ROLES {
        if role == Role::Token {
            continue;
        }
        h.ctx(account(role), 0);
        let refunded = h.hub.ft_on_transfer(acct(A), U128(5), budget_msg(&a));
        assert_eq!(refunded.0, 5, "{role:?}");
    }
    assert_eq!(h.budget(&a).escrow.0, 100);
}

#[test]
fn full_key_guards_need_exactly_one_yocto_and_admin_guards_at_least_one() {
    let (mut h, a, _) = world();
    for deposit in [0, 2] {
        h.expect_code(ONE_YOCTO_REQUIRED, |h| {
            h.ctx(acct(A), deposit);
            h.hub.fund_from_credit(a, U128(1));
        });
        h.expect_code(ONE_YOCTO_REQUIRED, |h| {
            h.ctx(node(), deposit);
            h.hub.register_receipt_key(pk(&agent(9)));
        });
        h.expect_code(ONE_YOCTO_REQUIRED, |h| {
            h.ctx(node(), deposit);
            h.hub.withdraw_storage(U128(1));
        });
    }
    h.ctx(admin(), plenty());
    h.hub.propose_admin(Some(acct("next-admin.test")));
    h.expect_code(ONE_YOCTO_REQUIRED, |h| {
        h.ctx(acct("next-admin.test"), 0);
        h.hub.accept_admin();
    });
    for call in [0, 1, 2] {
        h.expect_code(DEPOSIT_REQUIRED, |h| {
            h.ctx(admin(), 0);
            match call {
                0 => h.hub.set_settler(acct("x.test"), true),
                1 => h.hub.set_checkout_key(pk(&agent(9)), node()),
                _ => h.hub.propose_admin(None),
            }
        });
    }
}

/// Public methods declared in the hub's `#[near]` impl blocks, read from the sources.
fn public_methods() -> Vec<String> {
    let sources = [
        include_str!("../lib.rs"),
        include_str!("../budgets.rs"),
        include_str!("../settlement.rs"),
        include_str!("../payouts.rs"),
        include_str!("../storage.rs"),
        include_str!("../checkout.rs"),
        include_str!("../admin.rs"),
        include_str!("../views.rs"),
    ];
    let mut names: Vec<String> = sources
        .iter()
        .flat_map(|s| s.lines())
        .filter_map(|line| line.strip_prefix("    pub fn "))
        .map(|rest| rest.split('(').next().unwrap().to_string())
        .collect();
    names.sort();
    names
}

#[test]
fn every_public_method_is_either_guarded_or_open_to_anyone_by_decision() {
    let mut listed: Vec<String> = guarded()
        .into_iter()
        .map(|(m, ..)| m.to_string())
        .chain(ANYONE.iter().map(|m| m.to_string()))
        .collect();
    listed.sort();
    assert_eq!(public_methods(), listed);
}
