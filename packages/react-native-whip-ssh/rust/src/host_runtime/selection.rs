//! Copy Herdr selections from authoritative cells, retaining real line breaks.

use super::*;
use crate::herdr_api::{HerdrControlError, request_json_on_runtime};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::future::Future;

const COPY_TIMEOUT_MS: u64 = 5_000;
const MAX_VIEWPORT_CELLS: usize = 1_000_000;

/// Xterm's zero-based viewport cells; the end position is exclusive.
#[derive(Clone, Debug, uniffi::Record)]
pub struct TerminalSelectionSnapshot {
    pub columns: u16,
    pub text: String,
    pub rows: Vec<String>,
    pub start_row: u32,
    pub start_column: u16,
    pub end_row: u32,
    pub end_column: u16,
    pub offset_from_bottom: Option<u32>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct TextPoint {
    row: u32,
    col: u16,
}

#[derive(Deserialize)]
struct Scroll {
    offset_from_bottom: u64,
    max_offset_from_bottom: u64,
    viewport_rows: u64,
}

#[derive(Deserialize)]
struct SelectionPane {
    pane_id: String,
    terminal_id: String,
    scroll: Scroll,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CopyResponse {
    #[serde(rename = "pane_info")]
    Info { pane: SelectionPane },
    #[serde(rename = "pane_selection")]
    Selection { pane_id: String, text: String },
}

fn cancelled() -> HerdrControlError {
    HerdrControlError::RequestCancelled(
        "Terminal content or scroll position changed. Select the text and copy again.".to_owned(),
    )
}

fn decode(value: Value) -> Result<CopyResponse, HerdrControlError> {
    serde_json::from_value(value)
        .map_err(|error| HerdrControlError::MalformedResponse(error.to_string()))
}

fn selection_characters(text: &str) -> impl Iterator<Item = char> + '_ {
    text.chars().filter(|character| !character.is_whitespace())
}

impl TerminalSelectionSnapshot {
    fn range(&self) -> Result<(TextPoint, TextPoint), HerdrControlError> {
        let columns = usize::from(self.columns);
        let cells = self.rows.len().checked_mul(columns).ok_or_else(cancelled)?;
        if columns == 0
            || cells == 0
            || cells > MAX_VIEWPORT_CELLS
            || self.start_column > self.columns
            || self.end_column > self.columns
        {
            return Err(cancelled());
        }
        let index = |row: u32, col: u16| {
            usize::try_from(row)
                .ok()?
                .checked_mul(columns)?
                .checked_add(usize::from(col))
        };
        let start = index(self.start_row, self.start_column).ok_or_else(cancelled)?;
        let end = index(self.end_row, self.end_column).ok_or_else(cancelled)?;
        if start >= end || end > cells {
            return Err(cancelled());
        }
        let point = |index: usize| -> Result<TextPoint, HerdrControlError> {
            Ok(TextPoint {
                row: u32::try_from(index / columns).map_err(|_| cancelled())?,
                col: u16::try_from(index % columns).map_err(|_| cancelled())?,
            })
        };
        Ok((point(start)?, point(end - 1)?))
    }
}

async fn read_selection_using<F, Fut>(
    terminal_id: &str,
    pane_id: &str,
    snapshot: TerminalSelectionSnapshot,
    mut send: F,
) -> Result<String, HerdrControlError>
where
    F: FnMut(&'static str, Value) -> Fut,
    Fut: Future<Output = Result<Value, HerdrControlError>>,
{
    let (mut anchor, mut cursor) = snapshot.range()?;
    let CopyResponse::Info { pane } = decode(send("pane.get", json!({"pane_id":pane_id})).await?)?
    else {
        return Err(cancelled());
    };
    let scroll = pane.scroll;
    if pane.pane_id != pane_id
        || pane.terminal_id != terminal_id
        || scroll.viewport_rows != snapshot.rows.len() as u64
        || snapshot.offset_from_bottom.map(u64::from) != Some(scroll.offset_from_bottom)
    {
        return Err(cancelled());
    }
    let top = scroll
        .max_offset_from_bottom
        .checked_sub(scroll.offset_from_bottom)
        .and_then(|top| u32::try_from(top).ok())
        .ok_or_else(cancelled)?;
    anchor.row = anchor.row.checked_add(top).ok_or_else(cancelled)?;
    cursor.row = cursor.row.checked_add(top).ok_or_else(cancelled)?;
    let CopyResponse::Selection {
        pane_id: copied_pane,
        text,
    } = decode(
        send(
            "pane.selection.read",
            json!({"pane_id":pane_id,"anchor":anchor,"cursor":cursor}),
        )
        .await?,
    )?
    else {
        return Err(cancelled());
    };
    // Repaints lose wrap flags and paint blank cells as literal spaces. Check
    // the visible characters, keeping the server's spaces and breaks unchanged.
    // A pane-wide revision would also reject unrelated updates such as spinners.
    if copied_pane != pane_id
        || !selection_characters(&text).eq(selection_characters(&snapshot.text))
    {
        return Err(cancelled());
    }
    Ok(text)
}

fn selection_target(
    inner: &RuntimeInner,
    terminal_id: &str,
    pane_id: &str,
) -> Result<(u64, u64, u64), HerdrControlError> {
    let state = inner.state.lock();
    let terminal = state.terminals.get(terminal_id).ok_or_else(cancelled)?;
    let pane_matches = state
        .host_state
        .projection()
        .snapshot
        .as_ref()
        .is_some_and(|snapshot| {
            snapshot
                .panes
                .iter()
                .any(|pane| pane.terminal_id == terminal_id && pane.pane_id == pane_id)
        });
    if state.connection != HostConnectionState::Connected
        || terminal.state != HostTerminalState::Attached
        || !pane_matches
    {
        return Err(cancelled());
    }
    Ok((
        state.generation,
        state.herdr_recovery_revision,
        terminal.operation_epoch,
    ))
}

#[uniffi::export]
impl HostRuntime {
    pub async fn read_terminal_selection(
        &self,
        terminal_id: String,
        pane_id: String,
        snapshot: TerminalSelectionSnapshot,
    ) -> Result<String, HerdrControlError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HerdrControlError::TransportDisconnected)?
            .spawn(async move {
                let generation = selection_target(&inner, &terminal_id, &pane_id)?;
                read_selection_using(&terminal_id, &pane_id, snapshot, |method, params| {
                    let inner = inner.clone();
                    let terminal_id = terminal_id.clone();
                    let pane_id = pane_id.clone();
                    async move {
                        if selection_target(&inner, &terminal_id, &pane_id)? != generation {
                            return Err(cancelled());
                        }
                        let result = request_json_on_runtime(
                            inner.herdr.clone(),
                            method,
                            params,
                            COPY_TIMEOUT_MS,
                        )
                        .await;
                        if selection_target(&inner, &terminal_id, &pane_id)? != generation {
                            return Err(cancelled());
                        }
                        result
                    }
                })
                .await
            })
            .await
            .map_err(|error| HerdrControlError::RequestCancelled(error.to_string()))?
    }
}

#[cfg(test)]
mod tests;
