use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const MAX_TABS: usize = 3;
pub const MAX_REQUEST: usize = 64 * 1024;
pub const MAX_TEXT_RESULT: usize = 128 * 1024;
pub const MAX_IMAGE_RESULT: usize = 2 * 1024 * 1024;
pub const MAX_EVAL_RESULT: usize = 64 * 1024;
pub const MAX_READ: u32 = 16_000;
pub const MAX_INPUT: usize = 16_384;
pub const MAX_WAIT_MS: u32 = 10_000;

macro_rules! identifier {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
        #[serde(transparent)]
        pub struct $name(pub String);
        impl $name {
            pub fn validate(&self) -> Result<(), BrowserError> {
                if self.0.is_empty() || self.0.len() > 256 || self.0.chars().any(char::is_control) {
                    return Err(BrowserError::invalid("Invalid identifier"));
                }
                Ok(())
            }
        }
    };
}
identifier!(SessionId);
identifier!(TabId);
identifier!(ElementRef);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidArgument,
    UnknownAction,
    Unauthorized,
    TabClosed,
    TabLimit,
    SessionClosed,
    StaleRef,
    StalePage,
    StaleContent,
    NotFound,
    AmbiguousTarget,
    InvalidSelector,
    DisabledTarget,
    SensitiveTarget,
    NotEditable,
    InputRejected,
    NotSelect,
    OptionNotFound,
    AmbiguousOption,
    NotCheckable,
    Timeout,
    WaitTimeout,
    Cancelled,
    ResultTooLarge,
    InvalidResult,
    EvalFailed,
    NotSerializable,
    BrowserUnavailable,
    DeviceUnavailable,
    PermissionDenied,
    LocationUnavailable,
    SensorUnavailable,
}
#[derive(Clone, Debug, Deserialize, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct BrowserError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub details: Value,
}
impl BrowserError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: Value::Null,
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
    }
    pub fn mcp(&self) -> Value {
        json!({"isError":true,"structuredContent":{"error":self},"content":[{"type":"text","text":json!({"error":self}).to_string()}]})
    }
}

fn text(value: &str, maximum: usize, allow_empty: bool) -> Result<(), BrowserError> {
    if (!allow_empty && value.is_empty()) || value.len() > maximum {
        return Err(BrowserError::invalid("String outside allowed size"));
    }
    Ok(())
}
fn limit(value: Option<u32>, minimum: u32, maximum: u32) -> Result<(), BrowserError> {
    if value.is_some_and(|value| value < minimum || value > maximum) {
        return Err(BrowserError::invalid("Number outside allowed range"));
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<ElementRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub css: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact: Option<bool>,
}
impl Target {
    pub fn validate(&self) -> Result<(), BrowserError> {
        let fields = [
            &self.role,
            &self.name,
            &self.label,
            &self.text,
            &self.test_id,
            &self.css,
        ];
        let count = fields.iter().filter(|value| value.is_some()).count();
        if (self.r#ref.is_none() && count == 0) || (self.r#ref.is_some() && count != 0) {
            return Err(BrowserError::invalid(
                "Provide a ref or semantic/CSS locator",
            ));
        }
        if let Some(reference) = &self.r#ref {
            reference.validate()?;
        }
        for value in fields.into_iter().flatten() {
            text(value, 1024, false)?;
        }
        Ok(())
    }
}

macro_rules! args {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        pub struct $name {
            #[serde(skip_serializing_if = "Option::is_none")]
            pub tab_id: Option<TabId>,
            $(pub $field: $ty),*
        }
    };
}
args!(TabArgs {});
args!(NavigateArgs { url: String });
args!(NewTabArgs { url: Option<String> });
args!(FindArgs { role: Option<String>, name: Option<String>, label: Option<String>, text: Option<String>, test_id: Option<String>, css: Option<String>, exact: Option<bool>, limit: Option<u32> });
args!(GetArgs { property: GetProperty, target: Option<Target>, r#ref: Option<ElementRef>, max_chars: Option<u32> });
args!(ExtractArgs { target: Option<Target>, chunk_size: Option<u32>, start: Option<u32>, generation: Option<String> });
args!(TargetArgs { target: Option<Target>, r#ref: Option<ElementRef> });
args!(TypeArgs { target: Option<Target>, r#ref: Option<ElementRef>, text: String });
args!(KeysArgs { target: Option<Target>, r#ref: Option<ElementRef>, key: String });
args!(SelectArgs { target: Option<Target>, r#ref: Option<ElementRef>, option: String });
args!(ScrollArgs { x: Option<i32>, y: i32 });
args!(WaitArgs { condition: Option<WaitCondition>, target: Option<Target>, selector: Option<String>, text: Option<String>, url: Option<String>, previous_url: Option<String>, stable_ms: Option<u32>, timeout_ms: Option<u32> });
args!(ScreenshotArgs { annotate: Option<bool> });
args!(EvalArgs { js: String });
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GetProperty {
    Text,
    Value,
    Attributes,
    Html,
    Title,
    Url,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WaitCondition {
    Selector,
    Target,
    Text,
    Url,
    UrlChange,
    Stable,
}

macro_rules! actions {
    ($($variant:ident($args:ident) => $name:literal),* $(,)?) => {
        #[derive(Clone, Debug, Deserialize, Serialize)]
        #[serde(tag = "action", rename_all = "snake_case")]
        pub enum BrowserAction { $($variant($args)),* }
        impl BrowserAction {
            pub const NAMES: &'static [&'static str] = &[$($name),*];
            pub fn name(&self) -> &'static str { match self { $(Self::$variant(_) => $name),* } }
            pub fn tab_id(&self) -> Option<&TabId> { match self { $(Self::$variant(args) => args.tab_id.as_ref()),* } }
        }
    };
}
actions! {
    Navigate(NavigateArgs) => "navigate", Snapshot(TabArgs) => "snapshot", Find(FindArgs) => "find",
    Get(GetArgs) => "get", Extract(ExtractArgs) => "extract", Click(TargetArgs) => "click", Type(TypeArgs) => "type",
    Keys(KeysArgs) => "keys", Select(SelectArgs) => "select", Check(TargetArgs) => "check", Uncheck(TargetArgs) => "uncheck",
    Scroll(ScrollArgs) => "scroll", Wait(WaitArgs) => "wait", WaitForDom(WaitArgs) => "wait_for_dom",
    Screenshot(ScreenshotArgs) => "screenshot", Eval(EvalArgs) => "eval", Back(TabArgs) => "back",
    Forward(TabArgs) => "forward", Reload(TabArgs) => "reload", ListTabs(TabArgs) => "list_tabs",
    NewTab(NewTabArgs) => "new_tab", CloseTab(TabArgs) => "close_tab",
}

fn validate_target(
    target: Option<&Target>,
    reference: Option<&ElementRef>,
) -> Result<(), BrowserError> {
    match (target, reference) {
        (Some(target), None) => target.validate(),
        (None, Some(reference)) => reference.validate(),
        _ => Err(BrowserError::invalid("Provide target or ref, not both")),
    }
}
pub fn validate_url(value: &str) -> Result<(), BrowserError> {
    text(value, 8192, false)?;
    let url = url::Url::parse(value)
        .map_err(|_| BrowserError::invalid("An absolute HTTP(S) URL is required"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || value.contains('\\')
    {
        return Err(BrowserError::invalid(
            "HTTP(S) URL without embedded credentials required",
        ));
    }
    Ok(())
}
impl BrowserAction {
    pub fn parse(name: &str, arguments: &Value) -> Result<Self, BrowserError> {
        if !Self::NAMES.contains(&name) {
            return Err(BrowserError::new(
                ErrorCode::UnknownAction,
                "Unknown browser tool",
            ));
        }
        if arguments.to_string().len() > MAX_REQUEST {
            return Err(BrowserError::invalid("Browser request too large"));
        }
        let mut object = if arguments.is_null() {
            serde_json::Map::new()
        } else {
            arguments
                .as_object()
                .cloned()
                .ok_or_else(|| BrowserError::invalid("Arguments must be an object"))?
        };
        if object.contains_key("action") {
            return Err(BrowserError::invalid("Unexpected action argument"));
        }
        object.insert("action".into(), Value::String(name.into()));
        let action: Self = serde_json::from_value(Value::Object(object))
            .map_err(|_| BrowserError::invalid("Malformed browser arguments"))?;
        action.validate()?;
        Ok(action)
    }
    pub fn arguments(&self) -> Result<Value, BrowserError> {
        let mut value = serde_json::to_value(self)
            .map_err(|_| BrowserError::invalid("Cannot encode action"))?;
        value
            .as_object_mut()
            .ok_or_else(|| BrowserError::invalid("Cannot encode action"))?
            .remove("action");
        if let Some(object) = value.as_object_mut() {
            object.retain(|_, value| !value.is_null());
        }
        Ok(value)
    }
    pub fn validate(&self) -> Result<(), BrowserError> {
        if let Some(tab) = self.tab_id() {
            tab.validate()?;
        }
        match self {
            Self::Navigate(args) => validate_url(&args.url)?,
            Self::NewTab(args) => {
                if let Some(url) = &args.url {
                    validate_url(url)?;
                }
            }
            Self::Find(args) => {
                Target {
                    role: args.role.clone(),
                    name: args.name.clone(),
                    label: args.label.clone(),
                    text: args.text.clone(),
                    test_id: args.test_id.clone(),
                    css: args.css.clone(),
                    exact: args.exact,
                    ..Target::default()
                }
                .validate()?;
                limit(args.limit, 1, 50)?;
            }
            Self::Get(args) => {
                if !matches!(args.property, GetProperty::Title | GetProperty::Url) {
                    validate_target(args.target.as_ref(), args.r#ref.as_ref())?;
                }
                limit(args.max_chars, 1, MAX_READ)?;
            }
            Self::Extract(args) => {
                if let Some(target) = &args.target {
                    target.validate()?;
                }
                limit(args.chunk_size, 1, 12000)?;
                limit(args.start, 0, 262_144)?;
                if let Some(generation) = &args.generation {
                    text(generation, 256, false)?;
                }
            }
            Self::Click(args) | Self::Check(args) | Self::Uncheck(args) => {
                validate_target(args.target.as_ref(), args.r#ref.as_ref())?;
            }
            Self::Type(args) => {
                validate_target(args.target.as_ref(), args.r#ref.as_ref())?;
                text(&args.text, MAX_INPUT, true)?;
            }
            Self::Keys(args) => {
                validate_target(args.target.as_ref(), args.r#ref.as_ref())?;
                text(&args.key, 80, false)?;
                let mut parts = args.key.split('+').collect::<Vec<_>>();
                let key = parts.pop().unwrap_or_default();
                if ![
                    "Enter",
                    "Escape",
                    "Tab",
                    "ArrowUp",
                    "ArrowDown",
                    "ArrowLeft",
                    "ArrowRight",
                    "Home",
                    "End",
                    "Backspace",
                    "Delete",
                    "a",
                    "A",
                    " ",
                ]
                .contains(&key)
                    || parts
                        .iter()
                        .any(|part| !["Control", "Meta", "Shift", "Alt"].contains(part))
                {
                    return Err(BrowserError::invalid("Unsupported key"));
                }
            }
            Self::Select(args) => {
                validate_target(args.target.as_ref(), args.r#ref.as_ref())?;
                text(&args.option, 1024, true)?;
            }
            Self::Scroll(args) => {
                if args.x.unwrap_or_default().unsigned_abs() > 10000
                    || args.y.unsigned_abs() > 10000
                {
                    return Err(BrowserError::invalid("Scroll outside allowed range"));
                }
            }
            Self::Wait(args) | Self::WaitForDom(args) => {
                limit(args.timeout_ms, 1, MAX_WAIT_MS)?;
                limit(args.stable_ms, 1, 2000)?;
                match args.condition.unwrap_or(if args.target.is_some() {
                    WaitCondition::Target
                } else if args.selector.is_some() {
                    WaitCondition::Selector
                } else {
                    WaitCondition::Stable
                }) {
                    WaitCondition::Target => args
                        .target
                        .as_ref()
                        .ok_or_else(|| BrowserError::invalid("Target required"))?
                        .validate()?,
                    WaitCondition::Selector => text(
                        args.selector
                            .as_deref()
                            .ok_or_else(|| BrowserError::invalid("Selector required"))?,
                        1024,
                        false,
                    )?,
                    WaitCondition::Text => text(
                        args.text
                            .as_deref()
                            .ok_or_else(|| BrowserError::invalid("Text required"))?,
                        1024,
                        false,
                    )?,
                    WaitCondition::Url => text(
                        args.url
                            .as_deref()
                            .ok_or_else(|| BrowserError::invalid("URL match required"))?,
                        8192,
                        false,
                    )?,
                    _ => {}
                }
                if let Some(url) = &args.previous_url {
                    text(url, 8192, false)?;
                }
            }
            Self::Eval(args) => text(&args.js, MAX_REQUEST - 1024, false)?,
            _ => {}
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Page {
    pub url: String,
    pub title: String,
    pub generation: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Element {
    pub r#ref: ElementRef,
    pub role: String,
    pub name: String,
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SnapshotResult {
    #[serde(flatten)]
    pub page: Page,
    pub elements: Vec<Element>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FindResult {
    #[serde(flatten)]
    pub snapshot: SnapshotResult,
    pub matches: u32,
    pub truncated: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GetResult {
    #[serde(flatten)]
    pub page: Page,
    pub value: Value,
    #[serde(default)]
    pub truncated: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExtractResult {
    #[serde(flatten)]
    pub page: Page,
    pub content: String,
    pub start: u32,
    pub end: u32,
    pub total_chars: u32,
    pub next_start: Option<u32>,
    pub truncated: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WaitResult {
    #[serde(flatten)]
    pub page: Page,
    pub ready: bool,
    pub condition: WaitCondition,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TabInfo {
    pub tab_id: TabId,
    pub url: String,
    pub title: String,
    pub selected: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TabsResult {
    pub tabs: Vec<TabInfo>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    Click,
    Type,
    Keys,
    Select,
    Check,
    Uncheck,
    Scroll,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BrowserResult {
    Snapshot {
        tab_id: TabId,
        #[serde(flatten)]
        result: SnapshotResult,
    },
    Find {
        tab_id: TabId,
        #[serde(flatten)]
        result: FindResult,
    },
    Get {
        tab_id: TabId,
        #[serde(flatten)]
        result: GetResult,
    },
    Extract {
        tab_id: TabId,
        #[serde(flatten)]
        result: ExtractResult,
    },
    Wait {
        tab_id: TabId,
        #[serde(flatten)]
        result: WaitResult,
    },
    Eval {
        tab_id: TabId,
        value: Value,
    },
    Screenshot {
        tab_id: TabId,
        image: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        annotations: Option<SnapshotResult>,
    },
    Interaction {
        tab_id: TabId,
        performed: InteractionKind,
        #[serde(flatten)]
        page: Page,
    },
    Navigation {
        tab_id: TabId,
        url: String,
        navigated: bool,
    },
    Tabs {
        #[serde(flatten)]
        result: TabsResult,
    },
    NewTab {
        tab_id: TabId,
    },
    Closed {
        tab_id: TabId,
        closed: bool,
    },
}
impl BrowserResult {
    pub fn mcp(&self) -> Result<Value, BrowserError> {
        match self {
            Self::Snapshot { result, .. }
            | Self::Screenshot {
                annotations: Some(result),
                ..
            } => validate_elements(&result.elements, 200)?,
            Self::Find { result, .. } => validate_elements(&result.snapshot.elements, 50)?,
            Self::Get { result, .. } => {
                let size = result.value.as_str().map_or_else(
                    || result.value.to_string().len(),
                    |value| value.chars().count(),
                );
                if size > MAX_READ as usize {
                    return Err(BrowserError::new(
                        ErrorCode::ResultTooLarge,
                        "Read exceeds output limit",
                    ));
                }
            }
            Self::Extract { result, .. } => {
                if result.content.chars().count() > 12000
                    || result.total_chars > 262_144
                    || result.end > result.total_chars
                    || result.start > result.end
                    || result
                        .next_start
                        .is_some_and(|next| next != result.end || next >= result.total_chars)
                {
                    return Err(BrowserError::new(
                        ErrorCode::InvalidResult,
                        "Invalid extraction bounds",
                    ));
                }
            }
            Self::Eval { value, .. } if value.to_string().len() > MAX_EVAL_RESULT => {
                return Err(BrowserError::new(
                    ErrorCode::ResultTooLarge,
                    "Eval exceeds output limit",
                ));
            }
            Self::Tabs { result } if result.tabs.len() > MAX_TABS => {
                return Err(BrowserError::new(
                    ErrorCode::TabLimit,
                    "Browser tab limit exceeded",
                ));
            }
            _ => {}
        }
        let value = serde_json::to_value(self).map_err(|_| {
            BrowserError::new(ErrorCode::InvalidResult, "Cannot serialize browser result")
        })?;
        if value.to_string().len()
            > if matches!(self, Self::Screenshot { .. }) {
                MAX_IMAGE_RESULT
            } else {
                MAX_TEXT_RESULT
            }
        {
            return Err(BrowserError::new(
                ErrorCode::ResultTooLarge,
                "Browser result exceeds output limit",
            ));
        }
        if let Self::Screenshot {
            image,
            annotations,
            tab_id,
        } = self
        {
            let mut content = vec![json!({"type":"image","data":image,"mimeType":"image/jpeg"})];
            if let Some(annotations) = annotations {
                content.push(json!({"type":"text","text":json!({"tab_id":tab_id,"annotations":annotations}).to_string()}));
            }
            Ok(json!({"content":content}))
        } else {
            Ok(
                json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value}),
            )
        }
    }
}
fn validate_elements(elements: &[Element], maximum: usize) -> Result<(), BrowserError> {
    if elements.len() > maximum {
        return Err(BrowserError::new(
            ErrorCode::ResultTooLarge,
            "Too many browser elements",
        ));
    }
    for element in elements {
        element.r#ref.validate()?;
        if element.name.chars().count() > 160 || element.role.len() > 64 || element.tag.len() > 64 {
            return Err(BrowserError::new(
                ErrorCode::ResultTooLarge,
                "Element metadata exceeds limit",
            ));
        }
    }
    Ok(())
}
