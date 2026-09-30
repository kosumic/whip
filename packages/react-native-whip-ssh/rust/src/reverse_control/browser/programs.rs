use super::model::{BrowserError, ErrorCode, MAX_EVAL_RESULT};
use serde_json::{Value, json};

pub const DOM_RUNTIME: &str = include_str!("dom.js");

pub fn dom(key: &str, action: &str, args: &Value, identity: &str) -> String {
    format!(
        r"(() => {{ try {{ {DOM_RUNTIME}; return JSON.stringify({{ok:true,value:domRuntime({key},{action},{args},{identity})}}); }} catch (error) {{ return JSON.stringify({{ok:false,error:{{code:error.code || 'browser_unavailable',message:String(error.message || 'DOM action failed').slice(0,256),details:error.details || null}}}}); }} }})()",
        key = json!(key),
        action = json!(action),
        identity = json!(identity)
    )
}

// WebView.evaluateJavascript does not await promises. Start work in-page and
// poll its result using the native bridge; there is no message handler on-page.
// The source is intentionally unrestricted, but receives no native capability.
pub fn eval_start(key: &str, js: &str, expression: bool) -> String {
    let body = if expression {
        format!("return (\n{}\n);", js.trim().trim_end_matches(';'))
    } else {
        js.to_owned()
    };
    format!(
        r"(() => {{
        const key = {key};
        const job = {{ active:true, ready:false }};
        window[key] = job;
        job.timer = setTimeout(() => {{ job.active=false; if(window[key] === job) delete window[key]; }}, 20000);
        (async () => {{
            try {{
                const value = await (async () => {{ {body} }})();
                let encoded;
                try {{ encoded = JSON.stringify(value === undefined ? null : value); }}
                catch (_) {{ throw Object.assign(new Error('Eval result is not JSON serializable'),{{code:'not_serializable'}}); }}
                if (encoded === undefined) throw Object.assign(new Error('Eval result is not JSON serializable'),{{code:'not_serializable'}});
                if (new TextEncoder().encode(encoded).length > {MAX_EVAL_RESULT}) throw Object.assign(new Error('Eval result exceeds 65536 bytes'),{{code:'result_too_large'}});
                if (job.active) job.value = JSON.parse(encoded);
            }} catch(error) {{
                if(job.active) job.error = {{code:error.code === 'not_serializable' || error.code === 'result_too_large' ? error.code : 'eval_failed',message:error.code === 'not_serializable' || error.code === 'result_too_large' ? error.message : 'Page JavaScript failed'}};
            }} finally {{ job.ready = true; }}
        }})();
        return JSON.stringify({{ok:true,value:{{started:true}}}});
    }})()",
        key = json!(key)
    )
}
pub fn eval_poll(key: &str, cancel: bool) -> String {
    format!(
        r"(() => {{ const key={key}, job=window[key];
        if (!job) return JSON.stringify({{ok:false,error:{{code:'stale_page',message:'Eval page changed'}}}});
        if ({cancel}) {{ job.active=false; clearTimeout(job.timer); delete window[key]; return JSON.stringify({{ok:true,value:{{cancelled:true}}}}); }}
        if (!job.ready) return JSON.stringify({{ok:true,value:{{ready:false}}}});
        job.active=false; clearTimeout(job.timer); delete window[key];
        return JSON.stringify(job.error ? {{ok:false,error:job.error}} : {{ok:true,value:{{ready:true,data:job.value}}}});
    }})()",
        key = json!(key)
    )
}
pub fn unwrap_dom(value: Value) -> Result<Value, BrowserError> {
    if value["ok"] == true {
        return value
            .get("value")
            .cloned()
            .ok_or_else(|| BrowserError::new(ErrorCode::InvalidResult, "Missing page result"));
    }
    serde_json::from_value(value["error"].clone())
        .map_err(|_| BrowserError::new(ErrorCode::InvalidResult, "Invalid page error"))
        .and_then(Err)
}
