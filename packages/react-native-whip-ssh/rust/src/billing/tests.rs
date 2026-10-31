use super::{
    BillingAccessReason, BillingCapability, BillingChannel, BillingCustomerStatus,
    BillingEntitlement, BillingMembership, BillingPolicyInput, BillingPurchaseMethod, BillingTier,
    DAY_MS, RANCHER_ENTITLEMENT, TRIAL_DURATION_MS, TRIAL_ROLLOUT_MS, billing_rollout_policy,
    evaluate_billing_policy,
};

fn input() -> BillingPolicyInput {
    BillingPolicyInput {
        channel: BillingChannel::GooglePlay,
        developer_options_requested: false,
        developer_membership: None,
        customer_status: BillingCustomerStatus::Ready,
        entitlements: Vec::new(),
        installation_time_ms: None,
        installation_time_pending: false,
        now_ms: TRIAL_ROLLOUT_MS + DAY_MS,
        offering_available: true,
        package_available: true,
        web_checkout_available: false,
    }
}

fn paid_input() -> BillingPolicyInput {
    BillingPolicyInput {
        entitlements: vec![BillingEntitlement {
            identifier: RANCHER_ENTITLEMENT.to_owned(),
            is_active: true,
        }],
        ..input()
    }
}

#[test]
fn only_confirmed_active_rancher_entitlement_grants_lifetime_access() {
    let paid = evaluate_billing_policy(paid_input());
    assert_eq!(paid.tier, BillingTier::Rancher);
    assert!(paid.has_lifetime_access);
    assert_eq!(paid.access_reason, BillingAccessReason::Lifetime);
    for (identifier, is_active) in [("rancher", true), (RANCHER_ENTITLEMENT, false)] {
        let projection = evaluate_billing_policy(BillingPolicyInput {
            entitlements: vec![BillingEntitlement {
                identifier: identifier.to_owned(),
                is_active,
            }],
            ..input()
        });
        assert_eq!(projection.tier, BillingTier::Cowboy);
        assert!(!projection.has_lifetime_access);
        assert_eq!(projection.access_reason, BillingAccessReason::NoEntitlement);
    }
}

#[test]
fn unknown_sdk_states_cannot_grant_access_from_stale_entitlements() {
    for (customer_status, reason) in [
        (
            BillingCustomerStatus::Loading,
            BillingAccessReason::CustomerLoading,
        ),
        (
            BillingCustomerStatus::Unavailable,
            BillingAccessReason::CustomerUnavailable,
        ),
    ] {
        let projection = evaluate_billing_policy(BillingPolicyInput {
            customer_status,
            ..paid_input()
        });
        assert_eq!(projection.customer_status, customer_status);
        assert_eq!(projection.tier, BillingTier::Cowboy);
        assert!(!projection.has_lifetime_access);
        assert_eq!(projection.access_reason, reason);
    }
}

#[test]
fn trial_starts_at_rollout_and_expires_at_exactly_five_days() {
    for (elapsed, active, days) in [
        (0, true, 5),
        (DAY_MS - 1, true, 5),
        (DAY_MS, true, 4),
        (TRIAL_DURATION_MS - 1, true, 1),
        (TRIAL_DURATION_MS, false, 0),
        (TRIAL_DURATION_MS + DAY_MS, false, 0),
    ] {
        let projection = evaluate_billing_policy(BillingPolicyInput {
            installation_time_ms: Some(TRIAL_ROLLOUT_MS),
            now_ms: TRIAL_ROLLOUT_MS + elapsed,
            ..input()
        });
        assert_eq!(projection.trial.is_active, active);
        assert_eq!(projection.trial.days_remaining, days);
        assert_eq!(projection.trial.started_at_ms, Some(TRIAL_ROLLOUT_MS));
        assert_eq!(
            projection.trial.ends_at_ms,
            Some(TRIAL_ROLLOUT_MS + TRIAL_DURATION_MS)
        );
        assert_eq!(projection.tier == BillingTier::Rancher, active);
        assert!(!projection.has_lifetime_access);
        assert_eq!(projection.next_update_at_ms.is_some(), active);
    }
}

#[test]
fn missing_old_future_and_overflowed_install_times_are_ineligible() {
    for installation_time_ms in [
        None,
        Some(TRIAL_ROLLOUT_MS - 1),
        Some(input().now_ms + 1),
        Some(i64::MAX),
    ] {
        let projection = evaluate_billing_policy(BillingPolicyInput {
            installation_time_ms,
            ..input()
        });
        assert!(!projection.trial.is_active);
        assert_eq!(projection.trial.ends_at_ms, None);
    }
    let overflow = evaluate_billing_policy(BillingPolicyInput {
        installation_time_ms: Some(i64::MAX),
        now_ms: i64::MAX,
        ..input()
    });
    assert!(!overflow.trial.is_active);
}

#[test]
fn clock_changes_recompute_trial_and_countdown_deadline() {
    let mut request = BillingPolicyInput {
        installation_time_ms: Some(TRIAL_ROLLOUT_MS),
        ..input()
    };
    assert_eq!(
        evaluate_billing_policy(request.clone()).next_update_at_ms,
        Some(TRIAL_ROLLOUT_MS + 2 * DAY_MS)
    );
    request.now_ms = TRIAL_ROLLOUT_MS + TRIAL_DURATION_MS;
    assert_eq!(
        evaluate_billing_policy(request.clone()).next_update_at_ms,
        None
    );
    request.now_ms = TRIAL_ROLLOUT_MS + 1;
    assert_eq!(
        evaluate_billing_policy(request.clone())
            .trial
            .days_remaining,
        5
    );
    request.now_ms = TRIAL_ROLLOUT_MS - 1;
    assert_eq!(evaluate_billing_policy(request).tier, BillingTier::Cowboy);
}

#[test]
fn valid_trial_is_independent_of_purchase_sdk_availability() {
    let projection = evaluate_billing_policy(BillingPolicyInput {
        customer_status: BillingCustomerStatus::Unavailable,
        installation_time_ms: Some(TRIAL_ROLLOUT_MS),
        ..input()
    });
    assert_eq!(projection.access_reason, BillingAccessReason::Trial);
    assert!(!projection.has_lifetime_access);
}

#[test]
fn cowboy_has_no_paid_cosmetics_and_rancher_has_all_five() {
    assert!(evaluate_billing_policy(input()).capabilities.is_empty());
    assert_eq!(
        evaluate_billing_policy(paid_input()).capabilities,
        vec![
            BillingCapability::FullscreenApp,
            BillingCapability::FullscreenTerminal,
            BillingCapability::CustomAppBackground,
            BillingCapability::CustomTerminalBackground,
            BillingCapability::Glass,
        ]
    );
}

#[test]
fn store_builds_ignore_all_developer_overrides() {
    for channel in [BillingChannel::AppStore, BillingChannel::GooglePlay] {
        for developer_options_requested in [false, true] {
            let policy = billing_rollout_policy(channel, developer_options_requested);
            assert!(policy.billing_enabled);
            assert!(!policy.developer_options_available);
            assert!(!policy.developer_options_enabled);
            for developer_membership in [
                BillingMembership::Cowboy,
                BillingMembership::FreeTrial,
                BillingMembership::Rancher,
            ] {
                let projection = evaluate_billing_policy(BillingPolicyInput {
                    channel,
                    developer_options_requested,
                    developer_membership: Some(developer_membership),
                    ..input()
                });
                assert_eq!(projection.tier, BillingTier::Cowboy);
                assert_eq!(projection.access_reason, BillingAccessReason::NoEntitlement);
            }
        }
    }
}

#[test]
fn developer_preview_and_explicit_membership_override_preserve_precedence() {
    for channel in [BillingChannel::Github, BillingChannel::Unknown] {
        let preview = evaluate_billing_policy(BillingPolicyInput { channel, ..input() });
        assert_eq!(preview.tier, BillingTier::Rancher);
        assert_eq!(preview.access_reason, BillingAccessReason::DeveloperPreview);
        assert!(!preview.rollout.billing_enabled);
        assert!(!preview.has_lifetime_access);
        for (membership, tier, lifetime, trial) in [
            (BillingMembership::Cowboy, BillingTier::Cowboy, false, false),
            (
                BillingMembership::FreeTrial,
                BillingTier::Rancher,
                false,
                true,
            ),
            (
                BillingMembership::Rancher,
                BillingTier::Rancher,
                true,
                false,
            ),
        ] {
            let projection = evaluate_billing_policy(BillingPolicyInput {
                channel,
                developer_options_requested: true,
                developer_membership: Some(membership),
                ..paid_input()
            });
            assert_eq!(projection.tier, tier);
            assert_eq!(projection.has_lifetime_access, lifetime);
            assert_eq!(projection.trial.is_active, trial);
            assert_eq!(
                projection.access_reason,
                BillingAccessReason::DeveloperOverride
            );
        }
    }
}

#[test]
fn developer_trial_simulation_does_not_depend_on_installation_rollout() {
    let projection = evaluate_billing_policy(BillingPolicyInput {
        channel: BillingChannel::Github,
        developer_options_requested: true,
        developer_membership: Some(BillingMembership::FreeTrial),
        now_ms: TRIAL_ROLLOUT_MS - DAY_MS,
        ..input()
    });
    assert!(projection.trial.is_active);
    assert_eq!(projection.trial.days_remaining, 5);
    assert_eq!(
        projection.trial.ends_at_ms,
        Some(TRIAL_ROLLOUT_MS - DAY_MS + TRIAL_DURATION_MS)
    );
}

#[test]
fn purchase_routes_follow_distribution_and_available_platform_offerings() {
    assert_eq!(
        evaluate_billing_policy(input()).purchase_method,
        BillingPurchaseMethod::NativeStore
    );
    for (offering_available, package_available) in [(false, true), (true, false)] {
        assert_eq!(
            evaluate_billing_policy(BillingPolicyInput {
                offering_available,
                package_available,
                ..input()
            })
            .purchase_method,
            BillingPurchaseMethod::Unavailable
        );
    }
    for web_checkout_available in [false, true] {
        let projection = evaluate_billing_policy(BillingPolicyInput {
            channel: BillingChannel::Github,
            developer_options_requested: true,
            web_checkout_available,
            ..input()
        });
        assert_eq!(
            projection.purchase_method,
            if web_checkout_available {
                BillingPurchaseMethod::WebCheckout
            } else {
                BillingPurchaseMethod::Unavailable
            }
        );
        assert!(!projection.can_restore);
    }
    let unknown = evaluate_billing_policy(BillingPolicyInput {
        channel: BillingChannel::Unknown,
        developer_options_requested: true,
        web_checkout_available: true,
        ..input()
    });
    assert_eq!(unknown.purchase_method, BillingPurchaseMethod::Unavailable);
}
