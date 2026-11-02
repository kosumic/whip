//! Shared desktop/mobile attention labels. Legacy protocols never use this module.
use super::{
    Error,
    client::{CallError, Client, Transport},
    events::reported_status,
    generated::{Request, Response, Terminal, TerminalGetParams, TerminalLabelParams},
};
use crate::control::HerdrAgentStatus;

pub const SEEN_LABEL: &str = "herdr.seen";
pub const PINNED_LABEL: &str = "herdr.pinned";
pub const TURN_LABEL: &str = "hc.turn";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Attention {
    pub turn: u64,
    pub seen: Option<u64>,
    pub pinned: bool,
}
impl Attention {
    pub fn from_terminal(terminal: &Terminal) -> Self {
        Self {
            turn: terminal.turn.unwrap_or(0),
            seen: terminal
                .labels
                .get(SEEN_LABEL)
                .and_then(|value| parse_turn(value)),
            pinned: terminal
                .labels
                .get(PINNED_LABEL)
                .is_some_and(|value| !value.is_empty()),
        }
    }
}
pub fn parse_turn(value: &str) -> Option<u64> {
    (!value.is_empty() && value.bytes().all(|c| c.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}
pub fn status(terminal: &Terminal) -> HerdrAgentStatus {
    let reported = reported_status(terminal).map(|status| status.state.as_str());
    match reported {
        Some("blocked" | "error") => HerdrAgentStatus::Blocked,
        Some("working") => HerdrAgentStatus::Working,
        _ => {
            let attention = Attention::from_terminal(terminal);
            match attention.seen {
                Some(seen) if reported.is_some() => {
                    if attention.turn > seen {
                        HerdrAgentStatus::Done
                    } else {
                        HerdrAgentStatus::Idle
                    }
                }
                _ => match reported {
                    Some("done") => HerdrAgentStatus::Done,
                    Some("idle") => HerdrAgentStatus::Idle,
                    _ => HerdrAgentStatus::Unknown,
                },
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Viewing {
    terminal: Option<String>,
    observed: Option<u64>,
    epoch: u64,
}
impl Viewing {
    pub fn set_terminal(&mut self, terminal: Option<String>) {
        if self.terminal != terminal {
            self.terminal = terminal;
            self.observed = None;
            self.epoch = self.epoch.wrapping_add(1);
        }
    }
    pub fn terminal(&self) -> Option<&str> {
        self.terminal.as_deref()
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    /// Consume a viewed turn even when another client already marked it seen.
    /// A subsequent mark-unread is therefore respected until the view is reentered.
    pub fn observe(&mut self, attention: Attention) -> Option<u64> {
        if self.terminal.is_none() || self.observed == Some(attention.turn) {
            return None;
        }
        self.observed = Some(attention.turn);
        (attention.seen.is_none_or(|seen| seen < attention.turn)).then_some(attention.turn)
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Change {
    Seen(u64),
    Unread(Attention),
    Pinned(bool),
}
impl Client {
    pub fn attention(&self, terminal: &str) -> Option<Attention> {
        self.state()
            .snapshot
            .terminal(terminal)
            .map(Attention::from_terminal)
    }
    pub async fn update_attention<T: Transport>(
        &self,
        io: &T,
        terminal: &str,
        change: Change,
        allowed: impl Fn() -> bool + Send,
    ) -> Result<(), CallError<T::Failure>> {
        if !allowed() {
            return Ok(());
        }
        let Response::TerminalGet(current) = io
            .rpc(Request::terminal_get(TerminalGetParams {
                terminal: terminal.into(),
                ..Default::default()
            }))
            .await?
        else {
            return Err(Error::InvalidMessage("expected terminal.get".into()).into());
        };
        let current = Attention::from_terminal(&current);
        let (label, value) = match change {
            Change::Seen(turn)
                if current.turn == turn && current.seen.is_none_or(|seen| seen < turn) =>
            {
                (SEEN_LABEL, turn.to_string())
            }
            Change::Unread(expected) if expected.turn > 0 && current == expected => {
                (SEEN_LABEL, (expected.turn - 1).to_string())
            }
            Change::Pinned(pinned) if pinned != current.pinned => (
                PINNED_LABEL,
                if pinned { "1".into() } else { String::new() },
            ),
            _ => return Ok(()),
        };
        if allowed() {
            io.rpc(Request::terminal_label(TerminalLabelParams {
                terminal: terminal.into(),
                labels: [(label.into(), value)].into(),
            }))
            .await?;
        }
        Ok(())
    }
}
