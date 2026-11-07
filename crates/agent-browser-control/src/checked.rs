//! Checked waiting policy ported from Mika's BatchRunner.kt and UntilWait.kt.
//! Copyright 2026 wangzan101. Licensed under Apache-2.0 (see LICENSE-APACHE).
//! Modified for Whip: Rust deadlines/cancellation, owned DOM tabs, atomic predicates,
//! explicit expected dialogs, bounded reports and no replay of page actions.
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::{Duration, Instant};

use crate::engine::{Runner, decode};
use crate::model::{BrowserError, ErrorCode, ExpectationOutcome, StepReport, WaitArgs, WaitResult};

pub const SETTLE_TIMEOUT: Duration = Duration::from_millis(1500);
const QUIET_MS: u64 = 300;
const POLL_MS: u64 = 100;

#[derive(Clone, Debug, Serialize)]
pub struct Guard {
    pub baseline_dialogs: Option<Vec<u64>>,
    pub allowed_conditions: Vec<WaitArgs>,
    pub require_readable: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Observation {
    pub readable: bool,
    pub dialogs: Vec<u64>,
    pub stable_ms: u64,
    pub waits: Vec<WaitResult>,
}

pub async fn observe(
    runner: &Runner<'_>,
    guard: Option<&Guard>,
    conditions: &[WaitArgs],
) -> Result<Observation, BrowserError> {
    let mut args = serde_json::to_value(guard)
        .map_err(|_| BrowserError::invalid("Cannot encode page guard"))?;
    if args.is_null() {
        args = json!({});
    }
    args["conditions"] = json!(conditions);
    let observation: Observation = decode(runner.dom("checked", &args).await?)?;
    if !observation.readable && guard.is_none_or(|guard| guard.require_readable) {
        return Err(BrowserError::new(
            ErrorCode::UnreadablePage,
            "Cannot verify an unreadable page",
        ));
    }
    if observation.dialogs.len() > 64 || observation.waits.len() != conditions.len() {
        return Err(BrowserError::new(
            ErrorCode::InvalidResult,
            "Malformed checked page observation",
        ));
    }
    Ok(observation)
}

pub async fn settle(
    runner: &Runner<'_>,
    guard: &Guard,
    step: &mut StepReport,
) -> Result<Observation, BrowserError> {
    let began = Instant::now();
    loop {
        let result = observe(runner, Some(guard), &[]).await;
        step.settle_ms = milliseconds(began.elapsed());
        let observation = result?;
        if observation.stable_ms >= QUIET_MS {
            return Ok(observation);
        }
        if began.elapsed() >= SETTLE_TIMEOUT {
            return Err(BrowserError::new(
                ErrorCode::UnstablePage,
                "Page did not settle before the next action; no action was run",
            ));
        }
        tokio::time::sleep(
            Duration::from_millis(POLL_MS).min(SETTLE_TIMEOUT.saturating_sub(began.elapsed())),
        )
        .await;
    }
}

/// Every predicate must hold on the same DOM observation. Earlier true predicates
/// are rechecked, rather than latched while waiting for another condition.
pub async fn wait(
    runner: &Runner<'_>,
    guard: &Guard,
    conditions: &[WaitArgs],
    step: &mut StepReport,
) -> Result<Observation, BrowserError> {
    let began = Instant::now();
    loop {
        let result = observe(runner, Some(guard), conditions).await;
        step.wait_ms = milliseconds(began.elapsed());
        if let Err(error) = &result {
            step.failed_expectation = error.details["expectation_index"]
                .as_u64()
                .and_then(|index| usize::try_from(index).ok());
        }
        let observation = result?;
        step.expectation_outcomes = observation
            .waits
            .iter()
            .enumerate()
            .map(|(index, wait)| ExpectationOutcome {
                index,
                condition: wait.condition,
                met: wait.ready,
            })
            .collect();
        step.failed_expectation = observation.waits.iter().position(|wait| !wait.ready);
        if step.failed_expectation.is_none() {
            return Ok(observation);
        }
        let mut remaining = POLL_MS;
        for (index, (condition, wait)) in conditions.iter().zip(&observation.waits).enumerate() {
            if wait.ready {
                continue;
            }
            let timeout = u64::from(condition.timeout_ms.unwrap_or(5000));
            if step.wait_ms >= timeout {
                step.failed_expectation = Some(index);
                return Err(BrowserError::new(
                    ErrorCode::WaitTimeout,
                    "Step conditions did not hold together before the deadline",
                ));
            }
            remaining = remaining.min(timeout - step.wait_ms);
        }
        tokio::time::sleep(Duration::from_millis(remaining)).await;
    }
}

fn milliseconds(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}
