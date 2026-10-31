use std::sync::Arc;

use super::BrowserEffectPermit;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct BrowserOwner {
    pub runtime_id: String,
    pub session_id: String,
    pub pane_id: String,
    pub terminal_id: String,
}

impl From<&crate::ReverseControlSession> for BrowserOwner {
    fn from(value: &crate::ReverseControlSession) -> Self {
        Self {
            runtime_id: value.runtime_id.clone(),
            session_id: value.session_id.clone(),
            pane_id: value.pane_id.clone(),
            terminal_id: value.terminal_id.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum BrowserTabLifecycle {
    Active,
    Suspended,
    Crashed,
    Cleared,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum BrowserTabChange {
    UserAction,
    ProcessRestart,
    Document,
    Route,
    Crash,
    Suspend,
    Resume,
    ReserveView,
    Clear,
    ClearFinished,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct BrowserTabProjection {
    pub id: String,
    pub generation: u64,
    pub view_generation: u64,
    pub lifecycle: BrowserTabLifecycle,
    pub driver_generation: u64,
    pub interaction_generation: u64,
    pub attached: bool,
    pub url: String,
    pub title: String,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct BrowserPageDocument {
    pub id: String,
    pub url: String,
    pub public_url: String,
    pub ready: bool,
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum BrowserPlatformAction {
    CreateTab {
        tab_id: String,
    },
    CloseTab {
        tab_id: String,
    },
    Document {
        tab_id: String,
    },
    Evaluate {
        tab_id: String,
        script: String,
    },
    Navigate {
        tab_id: String,
        url: String,
    },
    Screenshot {
        tab_id: String,
        annotations_json: Option<String>,
    },
    Download {
        tab_id: String,
        url: String,
        max_bytes: u32,
    },
    Back {
        tab_id: String,
    },
    Forward {
        tab_id: String,
    },
    Reload {
        tab_id: String,
    },
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum BrowserPlatformResult {
    Done,
    Document {
        document: BrowserPageDocument,
    },
    Json {
        value_json: String,
    },
    Navigation {
        target: Option<String>,
        navigated: bool,
    },
    Image {
        image: String,
    },
    Download {
        local_path: String,
        bytes: u64,
        mime_type: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum BrowserOperationError {
    #[error("Browser action cancelled")]
    Cancelled,
    #[error("Browser session is not authorized")]
    Unauthorized,
    #[error("Browser session closed")]
    SessionClosed,
    #[error("Browser tab closed or unknown")]
    TabClosed,
    #[error("Page changed during action")]
    StalePage,
    #[error("Browser renderer is unavailable; reload this tab")]
    Unavailable,
}

#[derive(Clone, Copy, Debug, thiserror::Error, uniffi::Error)]
pub enum BrowserPlatformError {
    #[error("Browser renderer is unavailable; reload this tab")]
    Unavailable,
    #[error("Page JavaScript could not be evaluated")]
    EvalFailed,
    #[error("Browser download failed")]
    DownloadFailed,
}

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait BrowserOperationPlatform: Send + Sync {
    async fn ensure_session(
        &self,
        permit: Arc<BrowserEffectPermit>,
        owner: BrowserOwner,
        activate_route: bool,
    ) -> Result<(), BrowserPlatformError>;
    async fn prepare_tab(
        &self,
        permit: Arc<BrowserEffectPermit>,
        session_id: String,
        tab_id: String,
        resume: bool,
        navigation: bool,
    ) -> Result<(), BrowserPlatformError>;
    async fn perform(
        &self,
        permit: Arc<BrowserEffectPermit>,
        session_id: String,
        action: BrowserPlatformAction,
    ) -> Result<BrowserPlatformResult, BrowserPlatformError>;
    fn cancel(&self, effect_id: String);
    fn changed(&self, session_id: String);
}
