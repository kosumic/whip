//! Run without a browser, JavaScript runtime, or native SDK.
use agent_browser_control::{
    engine::{self, Bridge, Context, Primitive},
    model::{BrowserAction, BrowserError, ErrorCode, SessionId, TabId},
};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::Arc;

struct MemoryBrowser;
impl Bridge for MemoryBrowser {
    fn call(&self, operation: Primitive) -> BoxFuture<'_, Result<Value, BrowserError>> {
        Box::pin(async move {
            match operation {
                Primitive::ListTabs => Ok(
                    json!({"tabs":[{"tab_id":"example-tab-1","url":"about:blank","title":"Example","selected":true}]}),
                ),
                _ => Err(BrowserError::new(
                    ErrorCode::UnsupportedFeature,
                    "This example only lists tabs",
                )),
            }
        })
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let result = engine::run(
        Arc::new(MemoryBrowser),
        &SessionId("example".into()),
        "request-1",
        BrowserAction::parse("list_tabs", &json!({}))?,
        Context {
            tab_id: TabId(String::new()),
            tabs: vec![],
        },
    )
    .await?;
    println!("{}", result.mcp()?);
    Ok(())
}
