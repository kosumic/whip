//! Generation checks independent of browser UI, session registries, and SDKs.

/// A backend's current tab generations. Increment the corresponding generation
/// on document replacement/navigation, view replacement, driver replacement,
/// and user interaction. Capture and validate under the backend's state lock.
#[derive(Clone, Copy, Debug)]
pub struct TabState<'a> {
    pub tab: &'a str,
    pub generation: u64,
    pub view_generation: u64,
    pub driver_generation: u64,
    pub interaction_generation: u64,
    pub closed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum FenceError {
    #[error("Tab does not belong to this operation")]
    Unauthorized,
    #[error("Browser tab is closed")]
    TabClosed,
    #[error("Browser page changed")]
    StalePage,
}

/// A lease's captured tab generations. Optional generations let navigation and
/// driver preparation change the document or driver while fencing the view.
#[derive(Clone, Debug)]
pub struct TabFence {
    pub tab: String,
    pub generation: Option<u64>,
    pub view_generation: u64,
    pub driver_generation: Option<u64>,
    pub interaction_generation: u64,
    pub allow_closed: bool,
}

impl TabFence {
    pub fn validate(&self, tab: TabState<'_>) -> Result<(), FenceError> {
        self.validate_view(tab)?;
        if self
            .generation
            .is_some_and(|generation| generation != tab.generation)
        {
            return Err(FenceError::StalePage);
        }
        Ok(())
    }

    pub fn validate_view(&self, tab: TabState<'_>) -> Result<(), FenceError> {
        if self.tab != tab.tab {
            return Err(FenceError::Unauthorized);
        }
        if !self.allow_closed && tab.closed {
            return Err(FenceError::TabClosed);
        }
        if tab.view_generation != self.view_generation
            || self
                .driver_generation
                .is_some_and(|generation| generation != tab.driver_generation)
            || self.interaction_generation != tab.interaction_generation
        {
            return Err(FenceError::StalePage);
        }
        Ok(())
    }
}
