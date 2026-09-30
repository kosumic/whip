use super::{engine::*, model::*, programs};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Arc,
    time::Duration,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn all_actions_round_trip_with_typed_arguments() -> TestResult {
    for name in BrowserAction::NAMES {
        let args = match *name {
            "navigate" => json!({"url":"https://example.test/"}),
            "find" => json!({"role":"button","name":"Save","limit":5}),
            "get" => json!({"property":"text","target":{"role":"button"}}),
            "click" | "check" | "uncheck" => json!({"ref":"ref-1"}),
            "type" => json!({"target":{"label":"Query"},"text":""}),
            "keys" => json!({"target":{"css":"input"},"key":"Control+a"}),
            "select" => json!({"target":{"role":"combobox"},"option":"Newest"}),
            "scroll" => json!({"y":500}),
            "eval" => json!({"js":"await fetch('/api').then(r => r.json())"}),
            _ => json!({}),
        };
        let action = BrowserAction::parse(name, &args)?;
        assert_eq!(action.name(), *name);
        let serialized = serde_json::to_value(&action)?;
        let decoded: BrowserAction = serde_json::from_value(serialized)?;
        assert_eq!(decoded.name(), *name);
        BrowserAction::parse(name, &action.arguments()?)?;
    }
    Ok(())
}
#[test]
fn malformed_arguments_and_limits_fail_before_dispatch() {
    for (name, args) in [
        ("eval", json!({"js":3})),
        ("eval", json!({"js":"1","readonly":true})),
        ("snapshot", json!({"unknown":1})),
        ("navigate", json!({"url":"file:///secret"})),
        (
            "navigate",
            json!({"url":"https://user:secret@example.test/"}),
        ),
        ("find", json!({})),
        ("find", json!({"role":"button","limit":51})),
        ("click", json!({"target":{"name":"Save"},"ref":"ref"})),
        ("click", json!({"target":{"ref":"ref","css":"button"}})),
        ("type", json!({"ref":"ref","text":"x".repeat(MAX_INPUT+1)})),
        ("scroll", json!({"y":i32::MIN})),
        ("scroll", json!({"y":1.5})),
        (
            "get",
            json!({"property":"text","ref":"ref","max_chars":MAX_READ+1}),
        ),
        ("extract", json!({"chunk_size":12001})),
        ("extract", json!({"start":-1})),
        ("wait", json!({"condition":"text"})),
        ("wait", json!({"timeout_ms":MAX_WAIT_MS+1})),
        ("keys", json!({"ref":"ref","key":"executeNative"})),
        ("eval", json!({"js":"x".repeat(MAX_REQUEST)})),
        ("snapshot", json!(3)),
        ("snapshot", json!({"action":"eval"})),
    ] {
        assert_eq!(
            BrowserAction::parse(name, &args)
                .err()
                .map(|error| error.code),
            Some(ErrorCode::InvalidArgument),
            "{name}"
        );
    }
    assert_eq!(
        BrowserAction::parse("execute_js", &json!({}))
            .err()
            .map(|error| error.code),
        Some(ErrorCode::UnknownAction)
    );
}
#[test]
fn results_and_errors_have_structured_bounded_envelopes() -> TestResult {
    let result = BrowserResult::Eval {
        tab_id: TabId("a-tab-1".into()),
        value: json!({"items":[1,2]}),
    };
    let encoded = serde_json::to_string(&result)?;
    let decoded: BrowserResult = serde_json::from_str(&encoded)?;
    assert_eq!(
        decoded.mcp()?["structuredContent"]["value"],
        json!({"items":[1,2]})
    );
    let error = BrowserError::new(ErrorCode::StaleRef, "Observe again");
    assert_eq!(
        error.mcp()["structuredContent"]["error"]["code"],
        "stale_ref"
    );
    let huge = BrowserResult::Eval {
        tab_id: TabId("a-tab-1".into()),
        value: json!("x".repeat(MAX_TEXT_RESULT)),
    };
    assert_eq!(
        huge.mcp().err().map(|error| error.code),
        Some(ErrorCode::ResultTooLarge)
    );
    let huge_image = BrowserResult::Screenshot {
        tab_id: TabId("a-tab-1".into()),
        image: "a".repeat(MAX_IMAGE_RESULT),
        annotations: None,
    };
    assert_eq!(
        huge_image.mcp().err().map(|error| error.code),
        Some(ErrorCode::ResultTooLarge)
    );
    Ok(())
}
fn context() -> Context {
    Context {
        tab_id: TabId("a-tab-1".into()),
        tabs: vec![TabInfo {
            tab_id: TabId("a-tab-1".into()),
            url: "https://example.test/page".into(),
            title: "Test".into(),
            selected: true,
        }],
    }
}
#[test]
fn tab_authorization_is_checked_in_rust() -> TestResult {
    let session = SessionId("a".into());
    let action = BrowserAction::parse("snapshot", &json!({}))?;
    validate_context(&session, &action, &context())?;
    assert_eq!(
        authorize_tab(&session, &TabId("b-tab-1".into()))
            .err()
            .map(|error| error.code),
        Some(ErrorCode::Unauthorized)
    );
    let mut context = context();
    context.tab_id = TabId("a-tab-9".into());
    assert_eq!(
        validate_context(&session, &action, &context)
            .err()
            .map(|error| error.code),
        Some(ErrorCode::TabClosed)
    );
    context.tab_id = TabId("a-tab-1".into());
    let requested = BrowserAction::parse("snapshot", &json!({"tab_id":"a-tab-2"}))?;
    assert_eq!(
        validate_context(&session, &requested, &context)
            .err()
            .map(|error| error.code),
        Some(ErrorCode::Unauthorized)
    );
    Ok(())
}

// Exercise the actual Rust-generated programs in a DOM. The harness is only a
// test fixture and uses the repo's existing jsdom dependency.
struct PageProcess {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl PageProcess {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("node")
            .arg(root.join("scripts/browser-runtime-harness.cjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let input = child.stdin.take().ok_or("missing harness stdin")?;
        let output = BufReader::new(child.stdout.take().ok_or("missing harness stdout")?);
        Ok(Self {
            child,
            input,
            output,
        })
    }
    fn evaluate(&mut self, js: &str) -> Result<Value, BrowserError> {
        writeln!(self.input, "{}", json!({"js":js})).map_err(|_| {
            BrowserError::new(ErrorCode::BrowserUnavailable, "Harness write failed")
        })?;
        self.input.flush().map_err(|_| {
            BrowserError::new(ErrorCode::BrowserUnavailable, "Harness flush failed")
        })?;
        let mut line = String::new();
        self.output
            .read_line(&mut line)
            .map_err(|_| BrowserError::new(ErrorCode::BrowserUnavailable, "Harness read failed"))?;
        let value: Value = serde_json::from_str(&line)
            .map_err(|_| BrowserError::new(ErrorCode::InvalidResult, "Harness reply invalid"))?;
        if value.get("error").is_some() {
            return Err(BrowserError::new(
                ErrorCode::EvalFailed,
                "Page program syntax failure",
            ));
        }
        Ok(value["value"].clone())
    }
    fn dom(&mut self, action: &str, args: Value) -> Result<Value, BrowserError> {
        programs::unwrap_dom(self.evaluate(&programs::dom("test", action, &args, "doc-1"))?)
    }
}
impl Drop for PageProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn semantic_find_and_stale_refs_execute_rust_programs() -> TestResult {
    let mut page = PageProcess::new()?;
    let found = page.dom("find", json!({"role":"button","name":"Save","css":"input"}))?;
    assert_eq!(found["matches"], 1);
    let reference = found["elements"][0]["ref"].clone();
    assert!(
        reference
            .as_str()
            .is_some_and(|reference| reference.len() < 40)
    );
    let get = page.dom("get", json!({"property":"text","ref":reference}))?;
    assert_eq!(get["value"], "Save");
    assert_eq!(page.dom("find", json!({"label":"Query"}))?["matches"], 1);
    page.dom("type", json!({"target":{"label":"Query"},"text":"typed"}))?;
    assert_eq!(
        page.dom("click", json!({"ref":reference}))
            .err()
            .map(|error| error.code),
        Some(ErrorCode::StaleRef)
    );
    page.evaluate(
        "document.querySelector('main').insertAdjacentHTML('beforeend','<button>Save</button>')",
    )?;
    let error = page
        .dom("click", json!({"target":{"role":"button","name":"Save"}}))
        .err()
        .ok_or("expected ambiguity")?;
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.details["matches"], 2);
    let observed = page.dom("snapshot", json!({}))?;
    let reference = observed["elements"][0]["ref"].clone();
    page.evaluate("history.pushState({},'', '/new')")?;
    assert_eq!(
        page.dom("get", json!({"ref":reference,"property":"text"}))
            .err()
            .map(|error| error.code),
        Some(ErrorCode::StaleRef)
    );
    Ok(())
}
#[test]
fn bounded_get_and_paginated_extraction_omit_sensitive_and_hidden_content() -> TestResult {
    let mut page = PageProcess::new()?;
    page.evaluate("document.body.innerHTML='<nav>Noise</nav><main><h1>Heading</h1><p>'+ 'Readable '.repeat(40) + '<span hidden>secret-hidden</span></p><input type=password value=secret><script>secret-script</script></main>'")?;
    let first = page.dom("extract", json!({"chunk_size":43}))?;
    let mut content = first["content"].as_str().ok_or("content")?.to_owned();
    let mut next = first["next_start"].clone();
    while !next.is_null() {
        let chunk = page.dom(
            "extract",
            json!({"chunk_size":43,"start":next,"generation":first["generation"]}),
        )?;
        content.push_str(chunk["content"].as_str().ok_or("chunk")?);
        next = chunk["next_start"].clone();
    }
    assert!(content.starts_with("# Heading"));
    assert!(!content.contains("secret"));
    assert!(!content.contains("Noise"));
    assert_eq!(
        content.len() as u64,
        first["total_chars"].as_u64().ok_or("total chars")?
    );
    assert_eq!(
        page.dom(
            "get",
            json!({"property":"text","target":{"css":"p"},"max_chars":8})
        )?["value"],
        "Readable"
    );
    assert_eq!(
        page.dom("get", json!({"property":"value","target":{"css":"input"}}))
            .err()
            .map(|error| error.code),
        Some(ErrorCode::SensitiveTarget)
    );
    let html = page.dom("get", json!({"property":"html","target":{"css":"main"}}))?;
    assert!(!html["value"].as_str().ok_or("html")?.contains("secret"));
    page.evaluate("document.querySelector('p').textContent='Changed'")?;
    assert_eq!(
        page.dom(
            "extract",
            json!({"start":43,"generation":first["generation"]})
        )
        .err()
        .map(|error| error.code),
        Some(ErrorCode::StaleContent)
    );
    page.evaluate("document.querySelector('p').textContent='x'.repeat(300000)")?;
    let large = page.dom("extract", json!({"chunk_size":12000}))?;
    assert_eq!(
        large["content"].as_str().ok_or("large content")?.len(),
        12000
    );
    assert_eq!(large["truncated"], true);
    assert!(
        large["total_chars"]
            .as_u64()
            .is_some_and(|size| size <= 262_144)
    );
    Ok(())
}

struct PageBridge {
    page: Mutex<PageProcess>,
    calls: Mutex<Vec<Primitive>>,
}
impl Bridge for PageBridge {
    fn call(&self, operation: Primitive) -> BoxFuture<'_, Result<Value, BrowserError>> {
        Box::pin(async move {
            self.calls.lock().push(operation.clone());
            match operation {
                Primitive::DocumentState {..} => self.page.lock().evaluate("({id:'doc-1',identity:'a-tab-1-0',url:location.href,public_url:location.origin+location.pathname,ready:true})"),
                Primitive::Evaluate {js,..} => self.page.lock().evaluate(&js),
                Primitive::ListTabs => Ok(json!({"tabs":[{"tab_id":"a-tab-1","url":"https://example.test/page","title":"Test","selected":true}]})),
                _=>Err(BrowserError::new(ErrorCode::BrowserUnavailable,"Unexpected primitive")),
            }
        })
    }
}
fn page_bridge() -> Result<Arc<PageBridge>, Box<dyn std::error::Error>> {
    Ok(Arc::new(PageBridge {
        page: Mutex::new(PageProcess::new()?),
        calls: Mutex::new(Vec::new()),
    }))
}
#[test]
fn rust_engine_handles_snapshot_find_get_and_raw_async_eval() -> TestResult {
    crate::runtime()?.block_on(async {
        let bridge=page_bridge()?;
        let action=BrowserAction::parse("snapshot",&json!({}))?;
        let snapshot=run(bridge.clone(),&SessionId("a".into()),"1",action,context()).await?.mcp()?;
        assert_eq!(snapshot["structuredContent"]["kind"],"snapshot");
        assert_eq!(snapshot["structuredContent"]["elements"][2]["editable"],true);
        for js in [
            "await fetch('/api/data').then(r => r.json())",
            "performance.getEntriesByType ? performance.getEntriesByType('resource').filter(x => ['fetch','xmlhttprequest'].includes(x.initiatorType)).map(x => x.name) : []",
            "document.querySelector('button')?.click()",
            "localStorage.setItem('test', 'value'); return localStorage.getItem('test');",
        ] {
            let result=run(bridge.clone(),&SessionId("a".into()),"2",BrowserAction::parse("eval",&json!({"js":js}))?,context()).await?.mcp()?;
            assert_eq!(result["structuredContent"]["kind"],"eval");
        }
        let data=run(bridge.clone(),&SessionId("a".into()),"3",BrowserAction::parse("eval",&json!({"js":"await fetch('/api/data').then(r => r.json())"}))?,context()).await?.mcp()?;
        assert_eq!(data["structuredContent"]["value"]["authenticated"],true);
        Ok(())
    })
}
#[test]
fn raw_eval_reports_nonserializable_failed_and_oversized_results() -> TestResult {
    crate::runtime()?.block_on(async {
        let bridge = page_bridge()?;
        for (js, code) in [
            ("1n", ErrorCode::NotSerializable),
            (
                "(()=>{let x={};x.self=x;return x})()",
                ErrorCode::NotSerializable,
            ),
            (
                "Promise.reject(new Error('private error'))",
                ErrorCode::EvalFailed,
            ),
            ("'x'.repeat(65537)", ErrorCode::ResultTooLarge),
            ("'界'.repeat(22000)", ErrorCode::ResultTooLarge),
        ] {
            let error = run(
                bridge.clone(),
                &SessionId("a".into()),
                "1",
                BrowserAction::parse("eval", &json!({"js":js}))?,
                context(),
            )
            .await
            .err()
            .ok_or("expected eval failure")?;
            assert_eq!(error.code, code, "{js}");
        }
        Ok(())
    })
}
#[test]
fn rust_wait_enforces_timeout_and_semantic_conditions() -> TestResult {
    crate::runtime()?.block_on(async {
        let bridge = page_bridge()?;
        let ready = run(
            bridge.clone(),
            &SessionId("a".into()),
            "1",
            BrowserAction::parse(
                "wait",
                &json!({"target":{"role":"button","name":"Save"},"timeout_ms":100}),
            )?,
            context(),
        )
        .await?;
        assert!(matches!(ready, BrowserResult::Wait { .. }));
        let error = run(
            bridge,
            &SessionId("a".into()),
            "2",
            BrowserAction::parse(
                "wait",
                &json!({"condition":"text","text":"Missing","timeout_ms":5}),
            )?,
            context(),
        )
        .await
        .err()
        .ok_or("expected wait timeout")?;
        assert_eq!(error.code, ErrorCode::WaitTimeout);
        Ok(())
    })
}

#[test]
fn rust_deadline_bounds_async_eval_and_drops_pending_work() -> TestResult {
    crate::runtime()?.block_on(async {
        let bridge = page_bridge()?;
        let session = SessionId("a".into());
        let work = run(
            bridge,
            &session,
            "timeout",
            BrowserAction::parse("eval", &json!({"js":"new Promise(()=>{})"}))?,
            context(),
        );
        let error = deadline(Duration::from_millis(20), work)
            .await
            .err()
            .ok_or("expected deadline")?;
        assert_eq!(error.code, ErrorCode::Timeout);
        Ok(())
    })
}

#[derive(Default)]
struct FullTabsBridge {
    calls: Mutex<Vec<Primitive>>,
}
impl Bridge for FullTabsBridge {
    fn call(&self, operation: Primitive) -> BoxFuture<'_, Result<Value, BrowserError>> {
        Box::pin(async move {
            self.calls.lock().push(operation);
            Ok(
                json!({"tabs":(1..=MAX_TABS).map(|index|json!({"tab_id":format!("a-tab-{index}"),"url":"about:blank","title":"","selected":index==1})).collect::<Vec<_>>()}),
            )
        })
    }
}
#[test]
fn rust_prevents_tab_creation_at_the_limit_before_native_mutation() -> TestResult {
    crate::runtime()?.block_on(async {
        let bridge = Arc::new(FullTabsBridge::default());
        let action = BrowserAction::parse("new_tab", &json!({}))?;
        let error = run(
            bridge.clone(),
            &SessionId("a".into()),
            "1",
            action,
            context(),
        )
        .await
        .err()
        .ok_or("expected tab limit")?;
        assert_eq!(error.code, ErrorCode::TabLimit);
        assert_eq!(bridge.calls.lock().len(), 1);
        assert!(matches!(bridge.calls.lock()[0], Primitive::ListTabs));
        Ok(())
    })
}

#[test]
fn rust_handlers_route_typed_reads_and_normal_control_interactions() -> TestResult {
    crate::runtime()?.block_on(async {
        let bridge=page_bridge()?;
        bridge.page.lock().evaluate("document.body.innerHTML='<main><label for=q>Query</label><input id=q><label><input type=checkbox id=c>Alerts</label><select id=s aria-label=Sort><option value=new>Newest</option><option value=old>Oldest</option></select><p>Read this report</p></main>'; window.scrollBy=()=>{}")?;
        for (name,args) in [
            ("find",json!({"label":"Query"})),
            ("get",json!({"property":"text","target":{"css":"p"},"max_chars":20})),
            ("extract",json!({"chunk_size":30})),
            ("type",json!({"target":{"label":"Query"},"text":"agent"})),
            ("keys",json!({"target":{"label":"Query"},"key":"Control+a"})),
            ("check",json!({"target":{"css":"#c"}})),
            ("uncheck",json!({"target":{"css":"#c"}})),
            ("select",json!({"target":{"name":"Sort"},"option":"Oldest"})),
            ("scroll",json!({"y":500})),
        ] {
            let result=run(bridge.clone(),&SessionId("a".into()),name,BrowserAction::parse(name,&args)?,context()).await?.mcp()?;
            assert_eq!(result["structuredContent"]["tab_id"],"a-tab-1");
            if matches!(name,"type"|"keys"|"check"|"uncheck"|"select"|"scroll") {assert_eq!(result["structuredContent"]["performed"],name);}
        }
        assert_eq!(bridge.page.lock().evaluate("({value:document.querySelector('#q').value,checked:document.querySelector('#c').checked,selected:document.querySelector('#s').value})")?,json!({"value":"agent","checked":false,"selected":"old"}));
        Ok(())
    })
}

#[test]
fn unicode_chunk_cursors_and_document_identity_failures_are_structured() -> TestResult {
    crate::runtime()?.block_on(async {
        let bridge=page_bridge()?;
        bridge.page.lock().evaluate("document.body.innerHTML='<main><p>🙂界🙂</p></main>'")?;
        let first=run(bridge.clone(),&SessionId("a".into()),"1",BrowserAction::parse("extract",&json!({"chunk_size":1}))?,context()).await?.mcp()?;
        assert_eq!(first["structuredContent"]["content"],"🙂");
        let next=run(bridge.clone(),&SessionId("a".into()),"2",BrowserAction::parse("extract",&json!({"chunk_size":1,"start":first["structuredContent"]["next_start"],"generation":first["structuredContent"]["generation"]}))?,context()).await?.mcp()?;
        assert_eq!(next["structuredContent"]["content"],"界");
        bridge.page.lock().evaluate("document.__whipDocumentId='replaced'")?;
        let error=run(bridge,&SessionId("a".into()),"3",BrowserAction::parse("snapshot",&json!({}))?,context()).await.err().ok_or("expected document mismatch")?;
        assert_eq!(error.code,ErrorCode::StalePage);
        Ok(())
    })
}

#[test]
fn unicode_read_limits_never_emit_an_unpaired_surrogate() -> TestResult {
    let mut page = PageProcess::new()?;
    page.evaluate("document.title='a'.repeat(159)+'🙂';document.body.innerHTML='<button>'+ 'a'.repeat(159)+'🙂'+'</button><p>🙂🙂</p>'")?;
    let snapshot = page.dom("snapshot", json!({}))?;
    assert_eq!(snapshot["title"], "a".repeat(159));
    assert_eq!(snapshot["elements"][0]["name"], "a".repeat(159));
    let result = page.dom(
        "get",
        json!({"property":"text","target":{"css":"p"},"max_chars":3}),
    )?;
    assert_eq!(result["value"], "🙂");
    Ok(())
}
