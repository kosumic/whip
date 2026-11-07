//! Checked sequences share a caller's lease and never replay a page action.
//! Ported/adapted from Mika (Copyright 2026 wangzan101, Apache-2.0).
//! Modified for Whip's Rust engine; see NOTICE and LICENSE-APACHE.
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use serde_json::{Value, json};
use tokio::time::{Duration, Instant};

use crate::checked::{self, Guard, Observation};
use crate::control::OperationControl;
use crate::engine::{self, BoundedBridge, Bridge, Context, Document, Primitive};
use crate::model::{
    BrowserAction, BrowserError, BrowserResult, BrowserStep, ErrorCode, MAX_STEPS_MS,
    MAX_STEPS_RESULTS, RunStepsArgs, SessionId, StepReport, StepsPage, StepsReport, TabId,
    WaitCondition,
};

#[derive(Default)]
pub struct StepsProgress(Mutex<Option<(Instant, StepsReport)>>);

impl StepsProgress {
    fn publish(&self, start: Instant, report: &StepsReport) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((start, report.clone()));
    }

    /// Attach the latest partial report when a transport/native owner aborts work.
    pub fn with_error(&self, mut error: BrowserError) -> BrowserError {
        if error.details.get("report").is_some() {
            return error;
        }
        let state = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some((start, report)) = state.as_ref() {
            let mut report = report.clone();
            report.duration_ms = millis(start.elapsed());
            report.error = Some(bounded_error(error.clone()));
            if report.steps.len() > report.completed_steps
                && let Some(step) = report.steps.last_mut()
            {
                step.duration_ms = report.duration_ms.saturating_sub(step.duration_ms);
                step.error.clone_from(&report.error);
            }
            error.details = json!({"report":report,"action_may_have_run":true});
        }
        error
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn bounded_error(mut error: BrowserError) -> BrowserError {
    error.message = error.message.chars().take(1024).collect();
    if error.details.to_string().len() > 2048 {
        error.details = Value::Null;
    }
    error
}

fn page(document: &Document) -> StepsPage {
    StepsPage {
        url: document.public_url.clone(),
        generation: format!("{}:{}", document.identity, document.id),
    }
}

fn same_page(expected: &Document, actual: &Document) -> Result<(), BrowserError> {
    if expected.id != actual.id
        || expected.identity != actual.identity
        || expected.url != actual.url
        || !actual.ready
    {
        let mut error = BrowserError::new(
            ErrorCode::StalePage,
            "Page changed during run_steps; observe the page before continuing. Completed actions were not replayed.",
        );
        error.details = json!({"final_page":page(actual)});
        return Err(error);
    }
    Ok(())
}

/// Each DOM action still resolves its locator/ref anew, on the pinned document.
/// The URL check also closes the race with same-document navigation before JS.
struct PinnedBridge {
    inner: Arc<dyn Bridge>,
    tab: TabId,
    document: Document,
    guard: Option<Guard>,
    key: String,
}
impl Bridge for PinnedBridge {
    fn call(&self, operation: Primitive) -> BoxFuture<'_, Result<Value, BrowserError>> {
        Box::pin(async move {
            let operation = match operation {
                Primitive::Evaluate {
                    tab_id,
                    identity,
                    js,
                } => {
                    if tab_id != self.tab || identity != self.document.identity {
                        return Err(BrowserError::new(
                            ErrorCode::Unauthorized,
                            "Batch changed tab or document identity",
                        ));
                    }
                    Primitive::Evaluate {
                        tab_id,
                        identity,
                        js: format!(
                            "(() => {{ if (location.href !== {url}) return JSON.stringify({{ok:false,error:{{code:'stale_page',message:'Page URL changed during run_steps'}}}}); {guard} return ({js}); }})()",
                            url = json!(self.document.url),
                            guard = self.guard.as_ref().map_or_else(String::new, |guard| format!("const checked = ({}); if (!JSON.parse(checked).ok) return checked;", crate::programs::dom(&self.key, "checked", &json!(guard), &format!("{}:{}", self.document.identity, self.document.id))))
                        ),
                    }
                }
                operation => operation,
            };
            let reading_document = matches!(operation, Primitive::DocumentState { .. });
            let result = self.inner.call(operation).await?;
            if reading_document {
                same_page(&self.document, &engine::decode(result.clone())?)?;
            }
            Ok(result)
        })
    }
}

async fn within<T>(
    control: &OperationControl,
    expires: Instant,
    work: impl Future<Output = Result<T, BrowserError>>,
) -> Result<T, BrowserError> {
    control
        .run(async {
            tokio::time::timeout_at(expires, work).await.map_err(|_| {
                BrowserError::new(ErrorCode::Timeout, "run_steps total deadline exceeded")
            })?
        })
        .await
}

fn retain_result(report: &StepsReport, result: &BrowserResult) -> Result<(), BrowserError> {
    result.validate()?;
    if serde_json::to_vec(report)
        .map_or(usize::MAX, |v| v.len())
        .saturating_add(serde_json::to_vec(result).map_or(usize::MAX, |v| v.len()))
        > MAX_STEPS_RESULTS
    {
        return Err(BrowserError::new(
            ErrorCode::ResultTooLarge,
            "run_steps report limit reached; action may have completed. Inspect the page before continuing.",
        ));
    }
    Ok(())
}

struct Sequence<'a> {
    bridge: Arc<dyn Bridge>,
    session: &'a SessionId,
    request: &'a str,
    context: Context,
    progress: &'a StepsProgress,
    start: Instant,
}

impl Sequence<'_> {
    fn pinned(&self, document: Document, guard: Option<Guard>) -> Arc<dyn Bridge> {
        Arc::new(PinnedBridge {
            inner: self.bridge.clone(),
            tab: self.context.tab_id.clone(),
            document,
            guard,
            key: engine::runtime_key(self.session),
        })
    }

    async fn prepare(
        &self,
        before: &Document,
        previous: Option<&(Document, Observation)>,
        index: usize,
        report: &mut StepReport,
        navigation: bool,
    ) -> Result<(Arc<dyn Bridge>, Observation), BrowserError> {
        let pre_guard = Guard {
            baseline_dialogs: previous.map(|(_, observation)| observation.dialogs.clone()),
            allowed_conditions: Vec::new(),
            require_readable: !navigation,
        };
        let read_bridge = self.pinned(before.clone(), None);
        let reader = engine::observer(
            read_bridge.as_ref(),
            self.context.tab_id.clone(),
            self.session,
        );
        let observed = if index > 0 {
            checked::settle(&reader, &pre_guard, report).await?
        } else {
            checked::observe(&reader, Some(&pre_guard), &[]).await?
        };
        let pinned = self.pinned(
            before.clone(),
            Some(Guard {
                baseline_dialogs: Some(observed.dialogs.clone()),
                allowed_conditions: Vec::new(),
                require_readable: !navigation,
            }),
        );
        Ok((pinned, observed))
    }

    async fn step(
        &self,
        step: BrowserStep,
        index: usize,
        report: &mut StepsReport,
        previous: Option<&(Document, Observation)>,
    ) -> Result<(Document, Observation), BrowserError> {
        let observer = engine::observer(
            self.bridge.as_ref(),
            self.context.tab_id.clone(),
            self.session,
        );
        let before = observer.ready_document().await?;
        report.final_page = Some(page(&before));
        if let Some((expected, _)) = previous {
            same_page(expected, &before)?;
        }
        self.progress.publish(self.start, report);
        let action = BrowserAction::parse(&step.action, &step.arguments)?;
        let navigation = matches!(
            action,
            BrowserAction::Navigate(_)
                | BrowserAction::Back(_)
                | BrowserAction::Forward(_)
                | BrowserAction::Reload(_)
        );
        let (pinned, observed) = self
            .prepare(
                &before,
                previous,
                index,
                &mut report.steps[index],
                navigation,
            )
            .await?;
        let result = engine::deadline(
            engine::action_timeout(&action),
            Box::pin(engine::run_inner(
                if navigation {
                    self.bridge.clone()
                } else {
                    pinned.clone()
                },
                self.session,
                self.request,
                action,
                self.context.clone(),
                true,
            )),
        )
        .await?;
        retain_result(report, &result)?;
        report.steps[index].result = Some(Box::new(result));
        self.progress.publish(self.start, report);
        let after = observer.document().await?;
        report.final_page = Some(page(&after));
        if !navigation {
            same_page(&before, &after)?;
        }
        let mut conditions = step.expect;
        for expectation in &mut conditions {
            if expectation.condition == Some(WaitCondition::UrlChange)
                && expectation.previous_url.is_none()
            {
                expectation.previous_url = Some(before.url.clone());
            }
        }
        let post_guard = Guard {
            baseline_dialogs: Some(if navigation {
                Vec::new()
            } else {
                observed.dialogs
            }),
            allowed_conditions: conditions.clone(),
            require_readable: true,
        };
        let post_bridge = self.pinned(after.clone(), None);
        let post_reader = engine::observer(
            post_bridge.as_ref(),
            self.context.tab_id.clone(),
            self.session,
        );
        let checked = checked::wait(
            &post_reader,
            &post_guard,
            &conditions,
            &mut report.steps[index],
        )
        .await?;
        for wait in &checked.waits {
            let result = BrowserResult::Wait {
                tab_id: self.context.tab_id.clone(),
                result: wait.clone(),
            };
            retain_result(report, &result)?;
            report.steps[index].expectations.push(result);
            self.progress.publish(self.start, report);
        }
        report.steps[index].failed_expectation = None;
        let final_document = observer.document().await?;
        report.final_page = Some(page(&final_document));
        same_page(&after, &final_document)?;
        Ok((final_document, checked))
    }
}

/// The adapter must hold the same serialization lease for this entire future.
/// Cancellation drops the current primitive, revoking its native effect permit.
pub async fn run(
    bridge: Arc<dyn Bridge>,
    session: &SessionId,
    request: &str,
    args: RunStepsArgs,
    context: Context,
    control: &OperationControl,
    progress: &StepsProgress,
) -> Result<BrowserResult, BrowserError> {
    // Revalidate even when called directly by an adapter.
    let action = BrowserAction::parse(
        "run_steps",
        &serde_json::to_value(&args).map_err(|_| BrowserError::invalid("Cannot encode steps"))?,
    )?;
    session.validate()?;
    if request.is_empty() || request.len() > 256 || request.chars().any(char::is_control) {
        return Err(BrowserError::invalid("Invalid browser request identity"));
    }
    engine::validate_context(session, &action, &context)?;
    let bridge: Arc<dyn Bridge> = Arc::new(BoundedBridge(bridge));
    let start = Instant::now();
    let expires = start + Duration::from_millis(u64::from(args.timeout_ms.unwrap_or(MAX_STEPS_MS)));
    let mut report = StepsReport {
        tab_id: context.tab_id.clone(),
        steps: Vec::new(),
        total_steps: args.steps.len(),
        completed_steps: 0,
        duration_ms: 0,
        final_page: None,
        error: None,
    };
    progress.publish(start, &report);
    let sequence = Sequence {
        bridge,
        session,
        request,
        context,
        progress,
        start,
    };
    let mut previous: Option<(Document, Observation)> = None;
    for (index, step) in args.steps.into_iter().enumerate() {
        let began = Instant::now();
        report.steps.push(StepReport {
            index,
            action: step.action.clone(),
            result: None,
            expectations: Vec::new(),
            // While pending this is the start offset, used by cancellation snapshots.
            duration_ms: millis(start.elapsed()),
            failed_expectation: None,
            settle_ms: 0,
            wait_ms: 0,
            expectation_outcomes: Vec::new(),
            error: None,
        });
        progress.publish(start, &report);
        let work = Box::pin(sequence.step(step, index, &mut report, previous.as_ref()));
        let outcome = within(control, expires, work).await;
        report.steps[index].duration_ms = millis(began.elapsed());
        report.duration_ms = millis(start.elapsed());
        let next = match outcome {
            Ok(document) => document,
            Err(error) => {
                if let Ok(final_page) = serde_json::from_value(error.details["final_page"].clone())
                {
                    report.final_page = Some(final_page);
                }
                let error = bounded_error(error);
                report.steps[index].error = Some(error.clone());
                report.error = Some(error);
                // No extra native work after cancellation or expiry.
                progress.publish(start, &report);
                break;
            }
        };
        previous = Some(next);
        report.completed_steps += 1;
        progress.publish(start, &report);
    }
    let result = BrowserResult::RunSteps { report };
    result.validate()?;
    Ok(result)
}
