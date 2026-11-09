// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
//! Delegation notice scheduling, independent of transcript content delivery.
//! Retains lifecycle scheduling adapted from Codex realtime_conversation.rs at
//! f2b94ef8b52196f127d162c6db71e390b9bb265c.
use std::time::{Duration, Instant};

const PROGRESS_INTERVAL: Duration = Duration::from_secs(15);
pub(super) const BACKEND_PREFIX: &str = "[BACKEND] ";
pub(crate) const FINISHED_GUIDANCE: &str = "Use the source-attributed coding-agent context as the answer. This receipt contains status only, never a second copy of the answer. If context does not contain the answer, say it is unavailable in this voice call and direct the user to the agent chat. Completion applies only to the associated provider turn. Unknown, inferred, blocked or submitted observations do not establish completion. Do not resubmit the request.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Notice {
    Acknowledgement,
    Progress,
}
impl Notice {
    pub(super) fn instructions(self) -> &'static str {
        match self {
            Self::Acknowledgement => {
                "Briefly acknowledge the user's request in one short spoken sentence in their language. The agent call is pending. Describe your intent without claiming completion or inventing a result, then keep listening. If the user requested silence, remain silent."
            }
            Self::Progress => {
                "Give at most one short spoken sentence about new source-attributed coding-agent progress, in the user's language. Use only facts from the associated provider turn, never unrelated updates. Do not claim completion, invent progress, repeat an earlier update, or ask the user to wait. If there is no useful new progress or the user requested silence, remain silent."
            }
        }
    }
}

pub(super) struct Handoff {
    pub(super) call_id: String,
    response_id: String,
    acknowledgement: bool,
    progress: bool,
    last_notice: Instant,
}
impl Handoff {
    pub(super) fn new(
        call_id: String,
        response_id: String,
        already_spoke: bool,
        now: Instant,
    ) -> Self {
        Self {
            call_id,
            response_id,
            acknowledgement: !already_spoke,
            progress: false,
            last_notice: now,
        }
    }
    pub(super) fn silence(&mut self) {
        self.acknowledgement = false;
        self.progress = false;
    }
    pub(super) fn progress(&mut self) {
        self.progress = true;
    }
    pub(super) fn audio(&mut self, response_id: &str, now: Instant) {
        if self.response_id == response_id {
            self.acknowledgement = false;
            self.last_notice = now;
        }
    }
    pub(super) fn notice(&mut self, now: Instant) -> Option<Notice> {
        let notice = if self.acknowledgement {
            self.acknowledgement = false;
            Notice::Acknowledgement
        } else if self.progress && now.duration_since(self.last_notice) >= PROGRESS_INTERVAL {
            Notice::Progress
        } else {
            return None;
        };
        self.progress = false;
        self.last_notice = now;
        Some(notice)
    }
}
#[cfg(test)]
mod tests;
