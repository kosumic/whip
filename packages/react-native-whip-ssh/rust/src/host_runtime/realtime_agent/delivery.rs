use serde::Deserialize;

pub(crate) const BACKGROUND_AGENT: &str = "background_agent";
pub(crate) const REMAIN_SILENT: &str = "remain_silent";
const MAX_PROMPT_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Delivery {
    #[default]
    Now,
    Later,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Delegation {
    pub prompt: String,
    // Constructed only from native speech captions, never provider tool arguments.
    #[serde(skip)]
    pub context: Option<crate::realtime_voice::handoff_context::Snapshot>,
    #[serde(default)]
    pub delivery: Delivery,
}

impl Delegation {
    pub(crate) fn parse(arguments: &str) -> Result<Self, &'static str> {
        let request: Self = serde_json::from_str(arguments).map_err(|_| "invalid_arguments")?;
        if request.prompt.trim().is_empty()
            || request.prompt.len() > MAX_PROMPT_BYTES
            || request
                .prompt
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err("invalid_arguments");
        }
        Ok(request)
    }
}
