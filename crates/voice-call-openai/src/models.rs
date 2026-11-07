//! Single catalog shared with the settings presentation. USD rates per million tokens.
//! Sources (checked on the date in models.json):
//! https://developers.openai.com/api/docs/models/gpt-realtime-1.5
//! https://developers.openai.com/api/docs/models/gpt-realtime-2.1
//! https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini
use serde::Deserialize;
use std::sync::LazyLock;

const INVALID_CATALOG: &str = "Realtime model catalog is unavailable. Update the model catalog.";
pub const UNSUPPORTED: &str = "Choose a supported OpenAI Realtime model.";
pub const ACCESS_ERROR: &str = "OpenAI rejected the API credential or selected model access. Check the saved key and model access.";
pub const MISMATCH: &str = "OpenAI did not accept the selected Realtime model. Start a new call.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    default_model: String,
    models: Vec<Model>,
}

#[derive(Deserialize)]
pub struct Model {
    pub id: String,
    snapshots: Vec<String>,
    pub rates: Option<Rates>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rates {
    pub text_input: f64,
    pub cached_text_input: f64,
    pub text_output: f64,
    pub audio_input: f64,
    pub cached_audio_input: f64,
    pub audio_output: f64,
    pub image_input: f64,
    pub cached_image_input: f64,
}

static CATALOG: LazyLock<Result<Catalog, serde_json::Error>> =
    LazyLock::new(|| serde_json::from_str(include_str!("models.json")));

pub fn selected(id: Option<&str>) -> Result<&'static Model, &'static str> {
    let catalog = CATALOG.as_ref().map_err(|_| INVALID_CATALOG)?;
    let id = id.unwrap_or(&catalog.default_model);
    catalog
        .models
        .iter()
        .find(|model| model.id == id)
        .ok_or(UNSUPPORTED)
}

impl Model {
    pub fn accepts(&self, confirmed: &str) -> bool {
        self.id == confirmed || self.snapshots.iter().any(|snapshot| snapshot == confirmed)
    }

    pub fn websocket_url(&self) -> String {
        format!("wss://api.openai.com/v1/realtime?model={}", self.id)
    }
}
