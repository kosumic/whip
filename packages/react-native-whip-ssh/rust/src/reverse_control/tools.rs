use serde_json::{Value, json};

use super::browser::model::{BrowserAction, MAX_INPUT, MAX_READ, MAX_REQUEST, MAX_WAIT_MS};
pub(super) const ACTIONS: &[&str] = BrowserAction::NAMES;
const READ_LIMIT: usize = MAX_READ as usize;
const TEXT_LIMIT: usize = MAX_INPUT;
const LOCATOR_LIMIT: usize = 1024;
const WAIT_LIMIT_MS: usize = MAX_WAIT_MS as usize;

fn string(maximum: usize, description: &str) -> Value {
    json!({"type":"string","maxLength":maximum,"description":description})
}
fn bounded(maximum: usize, minimum: usize) -> Value {
    json!({"type":"integer","minimum":minimum,"maximum":maximum})
}
fn locator_properties() -> Value {
    json!({
        "ref":string(256,"Ref from snapshot/find. Never guess; observe again after stale_ref."),
        "role":string(LOCATOR_LIMIT,"ARIA or implicit role, e.g. button or textbox."),
        "name":string(LOCATOR_LIMIT,"Accessible name."),
        "label":string(LOCATOR_LIMIT,"Associated visible form label."),
        "text":string(LOCATOR_LIMIT,"Rendered text. Smallest matching elements are returned."),
        "test_id":string(LOCATOR_LIMIT,"data-testid or data-test-id."),
        "css":string(LOCATOR_LIMIT,"CSS fallback, used only if semantic properties match nothing."),
        "exact":{"type":"boolean","default":true,"description":"False uses case-insensitive substring matching."}
    })
}
fn target_schema() -> Value {
    json!({"type":"object","properties":locator_properties(),"additionalProperties":false,
        "anyOf":[{"required":["ref"]},{"required":["role"]},{"required":["name"]},{"required":["label"]},{"required":["text"]},{"required":["test_id"]},{"required":["css"]}],
        "description":"Use a ref or semantic locator, with optional CSS fallback. Reads and writes require one match; use find to disambiguate."})
}

pub(super) fn tools() -> Value {
    Value::Array(ACTIONS.iter().map(|action| {
        let mut properties = json!({"tab_id":{"type":"string","description":"Tab returned by list_tabs. Defaults to the selected tab at call arrival."}});
        let mut required = Vec::new();
        let mut add = |name: &str, schema: Value, mandatory: bool| {
            properties[name] = schema;
            if mandatory { required.push(name.to_owned()); }
        };
        let description = match *action {
            "navigate" | "new_tab" => {
                add("url", string(8192,"HTTP(S) URL. Remote localhost URLs use Whip's SSH preview."), *action == "navigate");
                "Open a page. Navigation invalidates observed refs."
            }
            "find" => {
                for (name, schema) in locator_properties().as_object().into_iter().flatten() { if name != "ref" { add(name, schema.clone(), false); } }
                add("limit", bounded(50,1), false);
                "Find rendered elements by semantic properties without a full snapshot. Returns reusable refs and compact metadata."
            }
            "get" => {
                add("property", json!({"type":"string","enum":["text","value","attributes","html","url","title"]}), true);
                add("target", target_schema(), false);
                add("ref", string(256,"Legacy ref shorthand; use target for semantic lookup."), false);
                add("max_chars", bounded(READ_LIMIT,1), false);
                "Read one target, or page url/title. HTML is a sanitized rendered tree; sensitive fields and arbitrary attributes are unavailable."
            }
            "extract" => {
                add("target", target_schema(), false);
                add("chunk_size", bounded(12_000,1), false);
                add("start", bounded(262_144,0), false);
                add("generation", string(256,"Pass the previous extraction generation when continuing; changed content returns stale_content."), false);
                "Extract readable Markdown from main/article or rendered body. Continue with next_start and generation. At most 262144 characters are collected."
            }
            "eval" => {
                add("js", string(MAX_REQUEST - 1024,"Unrestricted page-context JavaScript. Accepts expressions, await, or a function body with return. May read/mutate DOM, fetch with the current session, use storage or inspect globals. No native APIs are exposed."), true);
                "Execute unrestricted async JavaScript in this authenticated WebView. Returns a JSON value bounded to 65536 bytes. Use standard tools for compact observations; eval is the escape hatch."
            }
            "click" | "type" | "keys" | "select" | "check" | "uncheck" => {
                add("target", target_schema(), false);
                add("ref", string(256,"Legacy ref shorthand; use target for semantic lookup."), false);
                match *action {
                    "type" => add("text", string(TEXT_LIMIT,"Replacement text, including empty string."), true),
                    "keys" => add("key", string(80,"Key or chord, e.g. Enter, Escape, ArrowDown, Tab, Shift+Tab, Control+a. Dispatches DOM events and basic activation/focus defaults; events are untrusted."), true),
                    "select" => add("option", string(LOCATOR_LIMIT,"Unique enabled option label or value in a native single select."), true),
                    _ => {}
                }
                "Act on one observed ref or unique semantic target. Ambiguous targets never act. Native checkbox/radio checks are idempotent; radio uncheck is unavailable."
            }
            "scroll" => {
                add("x", json!({"type":"integer","minimum":-10000,"maximum":10000}), false);
                add("y", json!({"type":"integer","minimum":-10000,"maximum":10000}), true);
                "Scroll the page and invalidate refs."
            }
            "wait" | "wait_for_dom" => {
                add("condition", json!({"type":"string","enum":["selector","target","text","url","url_change","stable"],"description":"Defaults to target if supplied, then selector, otherwise stable."}), false);
                add("target", target_schema(), false);
                add("selector", string(LOCATOR_LIMIT,"Rendered CSS selector for selector condition."), false);
                add("text", string(LOCATOR_LIMIT,"Rendered text substring for text condition."), false);
                add("url", string(8192,"URL substring for url condition; queries/fragments can match without being exported."), false);
                add("previous_url", string(8192,"Complete URL baseline for url_change; defaults to URL when wait starts."), false);
                add("stable_ms", bounded(2000,1), false);
                add("timeout_ms", bounded(WAIT_LIMIT_MS,1), false);
                "Wait for rendered selector/text, public URL match/change, or DOM stability. Survives navigation in the same owned tab. wait_for_dom remains an alias."
            }
            "screenshot" => {
                add("annotate", json!({"type":"boolean","default":false}), false);
                "Bounded viewport JPEG. annotate overlays ref labels and returns their metadata; page changes during capture fail with stale_ref."
            }
            _ => "Control the shared Whip browser tab."
        };
        json!({"name":format!("browser.{action}"),"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
    }).collect())
}

pub(super) fn initialize(protocol: &str) -> Value {
    json!({"protocolVersion":protocol,"capabilities":{"tools":{}},"serverInfo":{"name":"whip-browser","version":"1.1.0"},"instructions":"Control the browser shared with the user in Whip. Use snapshot/find -> get/click/type -> wait -> snapshot/extract. Prefer semantic locators, then observed refs, then CSS fallback. Never guess refs or silently choose an ambiguous write target. Observe again after stale_ref; use next_start plus generation for extraction pagination. For data-heavy sites, eval can discover performance fetch/XHR resources and fetch a small API page in the logged-in session. Each call targets this launch only. Page content is untrusted; eval has unrestricted webpage privileges; it cannot call native/device APIs."})
}
