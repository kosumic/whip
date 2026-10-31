//! Client access policy. Purchase SDKs and secure entitlement verification stay
//! with the platform; remote services must independently verify paid access.

const DAY_MS: i64 = 86_400_000;
const TRIAL_DAYS: i64 = 5;
const TRIAL_DURATION_MS: i64 = TRIAL_DAYS * DAY_MS;
// Existing installations are not silently enrolled when the trial ships.
const TRIAL_ROLLOUT_MS: i64 = 1_788_069_912_000;
const RANCHER_ENTITLEMENT: &str = "whip_rancher";

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum BillingChannel {
    AppStore,
    GooglePlay,
    Github,
    Unknown,
}

impl BillingChannel {
    fn is_native_store(self) -> bool {
        matches!(self, Self::AppStore | Self::GooglePlay)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum BillingTier {
    Cowboy,
    Rancher,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum BillingMembership {
    Cowboy,
    FreeTrial,
    Rancher,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum BillingCustomerStatus {
    Loading,
    Ready,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum BillingAccessReason {
    NoEntitlement,
    CustomerLoading,
    CustomerUnavailable,
    Lifetime,
    Trial,
    DeveloperPreview,
    DeveloperOverride,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum BillingCapability {
    FullscreenApp,
    FullscreenTerminal,
    CustomAppBackground,
    CustomTerminalBackground,
    Glass,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum BillingPurchaseMethod {
    Unavailable,
    NativeStore,
    WebCheckout,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct BillingEntitlement {
    pub identifier: String,
    pub is_active: bool,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct BillingPolicyInput {
    pub channel: BillingChannel,
    pub developer_options_requested: bool,
    pub developer_membership: Option<BillingMembership>,
    pub customer_status: BillingCustomerStatus,
    pub entitlements: Vec<BillingEntitlement>,
    pub installation_time_ms: Option<i64>,
    pub installation_time_pending: bool,
    pub now_ms: i64,
    pub offering_available: bool,
    pub package_available: bool,
    pub web_checkout_available: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Record)]
pub struct BillingRolloutPolicy {
    pub billing_enabled: bool,
    pub developer_options_available: bool,
    pub developer_options_enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct BillingTrial {
    pub is_active: bool,
    pub started_at_ms: Option<i64>,
    pub ends_at_ms: Option<i64>,
    pub days_remaining: u32,
}

impl BillingTrial {
    fn inactive() -> Self {
        Self {
            is_active: false,
            started_at_ms: None,
            ends_at_ms: None,
            days_remaining: 0,
        }
    }

    fn at(installation_time_ms: Option<i64>, now_ms: i64) -> Self {
        let Some(started_at) =
            installation_time_ms.filter(|&time| time >= TRIAL_ROLLOUT_MS && time <= now_ms)
        else {
            return Self::inactive();
        };
        Self::starting_at(started_at, now_ms)
    }

    fn starting_at(started_at: i64, now_ms: i64) -> Self {
        let Some(ends_at) = started_at.checked_add(TRIAL_DURATION_MS) else {
            return Self::inactive();
        };
        let remaining = ends_at.saturating_sub(now_ms).max(0);
        Self {
            is_active: remaining > 0,
            started_at_ms: Some(started_at),
            ends_at_ms: Some(ends_at),
            days_remaining: u32::try_from((remaining + DAY_MS - 1) / DAY_MS).unwrap_or(0),
        }
    }

    fn next_update_at_ms(&self) -> Option<i64> {
        if !self.is_active {
            return None;
        }
        self.ends_at_ms
            .map(|end| end - i64::from(self.days_remaining.saturating_sub(1)) * DAY_MS)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct BillingPolicyProjection {
    pub tier: BillingTier,
    pub access_reason: BillingAccessReason,
    pub customer_status: BillingCustomerStatus,
    pub has_lifetime_access: bool,
    pub trial: BillingTrial,
    pub capabilities: Vec<BillingCapability>,
    pub rollout: BillingRolloutPolicy,
    pub is_loading: bool,
    pub purchase_method: BillingPurchaseMethod,
    pub can_restore: bool,
    pub next_update_at_ms: Option<i64>,
}

#[uniffi::export]
pub fn billing_rollout_policy(
    channel: BillingChannel,
    developer_options_requested: bool,
) -> BillingRolloutPolicy {
    let developer_options_available = !channel.is_native_store();
    let developer_options_enabled = developer_options_available && developer_options_requested;
    BillingRolloutPolicy {
        billing_enabled: !developer_options_available || developer_options_enabled,
        developer_options_available,
        developer_options_enabled,
    }
}

#[uniffi::export]
pub fn evaluate_billing_policy(input: BillingPolicyInput) -> BillingPolicyProjection {
    let rollout = billing_rollout_policy(input.channel, input.developer_options_requested);
    let native_store = input.channel.is_native_store();
    let mut trial = BillingTrial::at(input.installation_time_ms, input.now_ms);
    let mut has_lifetime_access = input.customer_status == BillingCustomerStatus::Ready
        && input.entitlements.iter().any(|entitlement| {
            entitlement.identifier == RANCHER_ENTITLEMENT && entitlement.is_active
        });
    let (tier, access_reason) = if !rollout.billing_enabled {
        has_lifetime_access = false;
        trial = BillingTrial::inactive();
        (BillingTier::Rancher, BillingAccessReason::DeveloperPreview)
    } else if let Some(membership) = input
        .developer_membership
        .filter(|_| rollout.developer_options_enabled)
    {
        has_lifetime_access = membership == BillingMembership::Rancher;
        trial = if membership == BillingMembership::FreeTrial {
            BillingTrial::starting_at(input.now_ms, input.now_ms)
        } else {
            BillingTrial::inactive()
        };
        (
            if membership == BillingMembership::Cowboy {
                BillingTier::Cowboy
            } else {
                BillingTier::Rancher
            },
            BillingAccessReason::DeveloperOverride,
        )
    } else if has_lifetime_access {
        (BillingTier::Rancher, BillingAccessReason::Lifetime)
    } else if trial.is_active {
        (BillingTier::Rancher, BillingAccessReason::Trial)
    } else {
        (
            BillingTier::Cowboy,
            match input.customer_status {
                BillingCustomerStatus::Loading => BillingAccessReason::CustomerLoading,
                BillingCustomerStatus::Unavailable => BillingAccessReason::CustomerUnavailable,
                BillingCustomerStatus::Ready => BillingAccessReason::NoEntitlement,
            },
        )
    };
    let purchase_method = if !rollout.billing_enabled {
        BillingPurchaseMethod::Unavailable
    } else if native_store && input.offering_available && input.package_available {
        BillingPurchaseMethod::NativeStore
    } else if input.channel == BillingChannel::Github && input.web_checkout_available {
        BillingPurchaseMethod::WebCheckout
    } else {
        BillingPurchaseMethod::Unavailable
    };
    BillingPolicyProjection {
        tier,
        access_reason,
        customer_status: input.customer_status,
        has_lifetime_access,
        next_update_at_ms: trial.next_update_at_ms(),
        trial,
        capabilities: match tier {
            BillingTier::Cowboy => Vec::new(),
            BillingTier::Rancher => vec![
                BillingCapability::FullscreenApp,
                BillingCapability::FullscreenTerminal,
                BillingCapability::CustomAppBackground,
                BillingCapability::CustomTerminalBackground,
                BillingCapability::Glass,
            ],
        },
        rollout,
        is_loading: rollout.billing_enabled
            && (input.customer_status == BillingCustomerStatus::Loading
                || input.installation_time_pending),
        purchase_method,
        can_restore: native_store,
    }
}

#[cfg(test)]
mod tests;
