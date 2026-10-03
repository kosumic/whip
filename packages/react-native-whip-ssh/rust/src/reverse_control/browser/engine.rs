use super::{model::*, programs};
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Primitive {
    ResolveTab {
        tab_id: Option<TabId>,
    },
    DocumentState {
        tab_id: TabId,
    },
    Evaluate {
        tab_id: TabId,
        identity: String,
        js: String,
    },
    Navigate {
        tab_id: TabId,
        url: String,
    },
    Screenshot {
        tab_id: TabId,
        identity: String,
        annotations: Option<Value>,
    },
    Download {
        tab_id: TabId,
        identity: String,
        url: String,
        destination_path: String,
        max_bytes: u32,
    },
    Back {
        tab_id: TabId,
    },
    Forward {
        tab_id: TabId,
    },
    Reload {
        tab_id: TabId,
    },
    ListTabs,
    NewTab,
    CloseTab {
        tab_id: TabId,
    },
}
impl Primitive {
    pub fn wire(&self) -> Result<(String, Value), BrowserError> {
        let mut value = serde_json::to_value(self).map_err(|_| {
            BrowserError::new(ErrorCode::InvalidArgument, "Cannot encode bridge operation")
        })?;
        let action = value["action"]
            .as_str()
            .ok_or_else(|| BrowserError::invalid("Missing bridge action"))?
            .to_owned();
        value
            .as_object_mut()
            .ok_or_else(|| BrowserError::invalid("Invalid bridge operation"))?
            .remove("action");
        Ok((action, value))
    }
}
pub trait Bridge: Send + Sync {
    fn call(&self, operation: Primitive) -> BoxFuture<'_, Result<Value, BrowserError>>;
}
pub async fn deadline<T>(
    duration: Duration,
    work: impl std::future::Future<Output = Result<T, BrowserError>>,
) -> Result<T, BrowserError> {
    tokio::time::timeout(duration, work)
        .await
        .map_err(|_| BrowserError::new(ErrorCode::Timeout, "Browser action timed out"))?
}
#[derive(Clone, Debug, Deserialize)]
pub struct Context {
    pub tab_id: TabId,
    pub tabs: Vec<TabInfo>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Document {
    pub id: String,
    pub url: String,
    pub public_url: String,
    pub ready: bool,
    pub identity: String,
}
#[derive(Clone, Debug, Deserialize)]
struct NavigationStarted {
    target: Option<String>,
    #[serde(default)]
    navigated: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Downloaded {
    destination_path: String,
    bytes: u64,
    mime_type: String,
}
#[derive(Default)]
pub struct BrowserSession {
    pub gate: Mutex<()>,
}

pub fn decode<T: DeserializeOwned>(value: Value) -> Result<T, BrowserError> {
    serde_json::from_value(value)
        .map_err(|_| BrowserError::new(ErrorCode::InvalidResult, "Malformed native browser result"))
}
pub fn authorize_tab(session: &SessionId, tab: &TabId) -> Result<(), BrowserError> {
    tab.validate()?;
    if !tab.0.starts_with(&format!("{}-tab-", session.0)) {
        return Err(BrowserError::new(
            ErrorCode::Unauthorized,
            "Tab belongs to another session",
        ));
    }
    Ok(())
}
pub fn validate_context(
    session: &SessionId,
    action: &BrowserAction,
    context: &Context,
) -> Result<(), BrowserError> {
    for tab in &context.tabs {
        authorize_tab(session, &tab.tab_id)?;
    }
    if !matches!(
        action,
        BrowserAction::NewTab(_) | BrowserAction::ListTabs(_)
    ) {
        authorize_tab(session, &context.tab_id)?;
        if !context.tabs.iter().any(|tab| tab.tab_id == context.tab_id) {
            return Err(BrowserError::new(
                ErrorCode::TabClosed,
                "Browser tab closed",
            ));
        }
        if action.tab_id().is_some_and(|tab| tab != &context.tab_id) {
            return Err(BrowserError::new(
                ErrorCode::Unauthorized,
                "Bridge changed requested tab",
            ));
        }
    }
    Ok(())
}

struct Runner<'a> {
    bridge: &'a dyn Bridge,
    tab: TabId,
    key: String,
}
impl Runner<'_> {
    async fn document(&self) -> Result<Document, BrowserError> {
        decode(
            self.bridge
                .call(Primitive::DocumentState {
                    tab_id: self.tab.clone(),
                })
                .await?,
        )
    }
    async fn evaluate(&self, document: &Document, js: String) -> Result<Value, BrowserError> {
        let js = format!(
            r"(() => {{ if(document.__whipDocumentId !== {id}) return JSON.stringify({{ok:false,error:{{code:'stale_page',message:'WebView document changed'}}}}); return ({js}); }})()",
            id = json!(document.id)
        );
        self.bridge
            .call(Primitive::Evaluate {
                tab_id: self.tab.clone(),
                identity: document.identity.clone(),
                js,
            })
            .await
    }
    async fn dom(&self, action: &str, args: &Value) -> Result<Value, BrowserError> {
        let document = self.document().await?;
        let identity = format!("{}:{}", document.identity, document.id);
        let mut arguments = args.clone();
        if action == "wait"
            && let (Ok(local), Ok(remote)) = (
                url::Url::parse(&document.url),
                url::Url::parse(&document.public_url),
            )
        {
            for field in ["url", "previous_url"] {
                if let Some(value) = arguments[field].as_str() {
                    arguments[field] = json!(value.replacen(
                        remote.origin().ascii_serialization().as_str(),
                        local.origin().ascii_serialization().as_str(),
                        1
                    ));
                }
            }
        }
        let result = self
            .evaluate(
                &document,
                programs::dom(&self.key, action, &arguments, &identity),
            )
            .await?;
        let mut value = programs::unwrap_dom(result)?;
        value["url"] = json!(document.public_url);
        if action == "get" && args["property"] == "url" {
            value["value"] = value["url"].clone();
        }
        Ok(value)
    }
    async fn navigation(&self, operation: Primitive) -> Result<BrowserResult, BrowserError> {
        let before = self.document().await?;
        let started: NavigationStarted = decode(self.bridge.call(operation).await?)?;
        if !started.navigated {
            return Ok(BrowserResult::Navigation {
                tab_id: self.tab.clone(),
                url: before.public_url,
                navigated: false,
            });
        }
        loop {
            let after = self.document().await?;
            let fragment_changed = started.target.as_ref().is_some_and(|target| {
                target != &before.url
                    && target.split('#').next() == before.url.split('#').next()
                    && target == &after.url
            });
            if after.ready && (after.id != before.id || after.url != before.url || fragment_changed)
            {
                return Ok(BrowserResult::Navigation {
                    tab_id: self.tab.clone(),
                    url: after.public_url,
                    navigated: true,
                });
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    async fn wait(&self, args: &WaitArgs) -> Result<BrowserResult, BrowserError> {
        let mut value =
            serde_json::to_value(args).map_err(|_| BrowserError::invalid("Invalid wait"))?;
        if let Some(object) = value.as_object_mut() {
            object.retain(|_, value| !value.is_null());
        }
        let condition = args.condition.unwrap_or(if args.target.is_some() {
            WaitCondition::Target
        } else if args.selector.is_some() {
            WaitCondition::Selector
        } else {
            WaitCondition::Stable
        });
        value["condition"] = json!(condition);
        if condition == WaitCondition::UrlChange && args.previous_url.is_none() {
            value["previous_url"] = json!(self.document().await?.url);
        }
        let timeout = Duration::from_millis(u64::from(args.timeout_ms.unwrap_or(5000)));
        let waiting = async {
            loop {
                match self.dom("wait", &value).await {
                    Ok(raw) => {
                        let result: WaitResult = decode(raw)?;
                        if result.ready {
                            return Ok(BrowserResult::Wait {
                                tab_id: self.tab.clone(),
                                result,
                            });
                        }
                    }
                    Err(error) if error.code == ErrorCode::StalePage => {}
                    Err(error) => return Err(error),
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        };
        tokio::time::timeout(timeout, waiting)
            .await
            .map_err(|_| BrowserError::new(ErrorCode::WaitTimeout, "Browser wait timed out"))?
    }
    async fn eval(&self, source: &str, request: &str) -> Result<BrowserResult, BrowserError> {
        let document = self.document().await?;
        let key = format!("{}_eval_{request}", self.key);
        let started = self
            .evaluate(&document, programs::eval_start(&key, source, true))
            .await;
        // A syntax error occurs before any page code ran. Retry as a statement
        // body to support declarations and explicit return as well as expressions.
        match started {
            Ok(raw) if !raw.is_null() => {
                programs::unwrap_dom(raw)?;
            }
            Err(error)
                if !matches!(
                    error.code,
                    ErrorCode::InvalidResult
                        | ErrorCode::EvalFailed
                        | ErrorCode::BrowserUnavailable
                ) =>
            {
                return Err(error);
            }
            Ok(_) | Err(_) => {
                programs::unwrap_dom(
                    self.evaluate(&document, programs::eval_start(&key, source, false))
                        .await
                        .map_err(|error| {
                            if matches!(
                                error.code,
                                ErrorCode::InvalidResult
                                    | ErrorCode::EvalFailed
                                    | ErrorCode::BrowserUnavailable
                            ) {
                                BrowserError::new(
                                    ErrorCode::EvalFailed,
                                    "Page JavaScript could not be evaluated",
                                )
                            } else {
                                error
                            }
                        })?,
                )?;
            }
        }
        loop {
            let raw = self
                .evaluate(&document, programs::eval_poll(&key, false))
                .await?;
            let result = programs::unwrap_dom(raw)?;
            if result["ready"] == true {
                let value = result.get("data").cloned().ok_or_else(|| {
                    BrowserError::new(ErrorCode::InvalidResult, "Missing eval result")
                })?;
                if value.to_string().len() > MAX_EVAL_RESULT {
                    return Err(BrowserError::new(
                        ErrorCode::ResultTooLarge,
                        "Eval result exceeds 65536 bytes",
                    ));
                }
                return Ok(BrowserResult::Eval {
                    tab_id: self.tab.clone(),
                    value,
                });
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

pub async fn run(
    bridge: Arc<dyn Bridge>,
    session: &SessionId,
    request: &str,
    action: BrowserAction,
    context: Context,
) -> Result<BrowserResult, BrowserError> {
    validate_context(session, &action, &context)?;
    let runner = Runner {
        bridge: bridge.as_ref(),
        tab: context.tab_id.clone(),
        key: format!("__whip_browser_{}", session.0),
    };
    let tab_id = context.tab_id;
    let args = action.arguments()?;
    match action {
        BrowserAction::ListTabs(_) => {
            let result: TabsResult = decode(bridge.call(Primitive::ListTabs).await?)?;
            for tab in &result.tabs {
                authorize_tab(session, &tab.tab_id)?;
            }
            Ok(BrowserResult::Tabs { result })
        }
        BrowserAction::NewTab(args) => {
            let tabs: TabsResult = decode(bridge.call(Primitive::ListTabs).await?)?;
            for tab in &tabs.tabs {
                authorize_tab(session, &tab.tab_id)?;
            }
            let created = bridge.call(Primitive::NewTab).await?;
            let tab: TabId = decode(created["tab_id"].clone())?;
            authorize_tab(session, &tab)?;
            if let Some(url) = args.url {
                let new_runner = Runner {
                    bridge: bridge.as_ref(),
                    tab: tab.clone(),
                    key: runner.key,
                };
                if let Err(error) = new_runner
                    .navigation(Primitive::Navigate {
                        tab_id: tab.clone(),
                        url,
                    })
                    .await
                {
                    let _ = bridge.call(Primitive::CloseTab { tab_id: tab }).await;
                    return Err(error);
                }
            }
            Ok(BrowserResult::NewTab { tab_id: tab })
        }
        BrowserAction::CloseTab(_) => {
            bridge
                .call(Primitive::CloseTab {
                    tab_id: tab_id.clone(),
                })
                .await?;
            Ok(BrowserResult::Closed {
                tab_id,
                closed: true,
            })
        }
        BrowserAction::Navigate(args) => {
            runner
                .navigation(Primitive::Navigate {
                    tab_id,
                    url: args.url,
                })
                .await
        }
        BrowserAction::Back(_) => runner.navigation(Primitive::Back { tab_id }).await,
        BrowserAction::Forward(_) => runner.navigation(Primitive::Forward { tab_id }).await,
        BrowserAction::Reload(_) => runner.navigation(Primitive::Reload { tab_id }).await,
        BrowserAction::Wait(args) => runner.wait(&args).await,
        BrowserAction::Eval(args) => runner.eval(&args.js, request).await,
        BrowserAction::Download(args) => {
            let document = runner.document().await?;
            let result = bridge
                .call(Primitive::Download {
                    tab_id: tab_id.clone(),
                    identity: document.identity,
                    url: args.url,
                    destination_path: args.destination_path,
                    max_bytes: args.max_bytes.unwrap_or(MAX_DOWNLOAD_BYTES),
                })
                .await?;
            let result: Downloaded = decode(result)?;
            Ok(BrowserResult::Download {
                tab_id,
                destination_path: result.destination_path,
                bytes: result.bytes,
                mime_type: result.mime_type,
            })
        }
        BrowserAction::Screenshot(args) => {
            let document = runner.document().await?;
            let raw = if args.annotate.unwrap_or(false) {
                Some(runner.dom("annotations", &json!({})).await?)
            } else {
                None
            };
            let result = bridge
                .call(Primitive::Screenshot {
                    tab_id: tab_id.clone(),
                    identity: document.identity,
                    annotations: raw.clone(),
                })
                .await?;
            let image = result["image"]
                .as_str()
                .ok_or_else(|| {
                    BrowserError::new(ErrorCode::InvalidResult, "Invalid screenshot result")
                })?
                .to_owned();
            if let Some(raw) = &raw {
                runner
                    .dom("annotation_check", &json!({"generation":raw["generation"]}))
                    .await?;
            }
            Ok(BrowserResult::Screenshot {
                tab_id,
                image,
                annotations: raw.map(decode).transpose()?,
            })
        }
        action => {
            let value = runner.dom(action.name(), &args).await?;
            match action {
                BrowserAction::Snapshot(_) => Ok(BrowserResult::Snapshot {
                    tab_id,
                    result: decode(value)?,
                }),
                BrowserAction::Find(_) => Ok(BrowserResult::Find {
                    tab_id,
                    result: decode(value)?,
                }),
                BrowserAction::Get(_) => Ok(BrowserResult::Get {
                    tab_id,
                    result: decode(value)?,
                }),
                BrowserAction::Extract(_) => Ok(BrowserResult::Extract {
                    tab_id,
                    result: decode(value)?,
                }),
                _ => Ok(BrowserResult::Interaction {
                    tab_id,
                    performed: decode(json!(action.name()))?,
                    page: decode(value)?,
                }),
            }
        }
    }
}
