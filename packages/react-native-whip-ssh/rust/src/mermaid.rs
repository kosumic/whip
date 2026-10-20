//! Bounded, headless Mermaid rendering for file and Markdown previews.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use merman::svg::{RenderResourcePolicy, ResourceLimitId, SvgPipeline, SvgRenderOptions};
use merman::{
    Engine, MermaidConfig, OperationControl, RenderOutput, RenderRequest, Renderer, SvgEnvironment,
    SvgRequest,
};
use tokio::sync::Semaphore;

const MAX_SOURCE_BYTES: usize = 100_000;
const MAX_MODEL_ITEMS: usize = 1_500;
const RENDER_DEADLINE: Duration = Duration::from_secs(5);
const FONT_FAMILY: &str = "WhipChatCJK, WhipInter, system-ui, sans-serif";
static RENDER_SLOTS: Semaphore = Semaphore::const_new(2);
static DIAGRAM_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MermaidRenderError {
    #[error("The Mermaid document is empty")]
    Empty,
    #[error("The Mermaid document is too large to preview")]
    TooLarge,
    #[error("Could not render Mermaid diagram: {0}")]
    RenderFailed(String),
}

struct CancelOnDrop(OperationControl);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// Returns SVG from Merman without running JavaScript or measuring browser DOM.
#[uniffi::export]
pub async fn render_mermaid_svg(source: String, dark: bool) -> Result<String, MermaidRenderError> {
    validate_source(&source)?;
    let control = OperationControl::new();
    // UniFFI cancellation drops this future; cancel any already-running blocking work too.
    let _cancel = CancelOnDrop(control.clone());
    let permit = RENDER_SLOTS
        .acquire()
        .await
        .map_err(|error| MermaidRenderError::RenderFailed(error.to_string()))?;
    crate::runtime()
        .map_err(MermaidRenderError::RenderFailed)?
        .spawn_blocking(move || {
            let _permit = permit;
            render(&source, dark, control)
        })
        .await
        .map_err(|error| MermaidRenderError::RenderFailed(error.to_string()))?
}

fn validate_source(source: &str) -> Result<(), MermaidRenderError> {
    if source.trim().is_empty() {
        return Err(MermaidRenderError::Empty);
    }
    if source.len() > MAX_SOURCE_BYTES {
        return Err(MermaidRenderError::TooLarge);
    }
    Ok(())
}

fn render(
    source: &str,
    dark: bool,
    control: OperationControl,
) -> Result<String, MermaidRenderError> {
    let config = MermaidConfig::from_value(serde_json::json!({
        "theme": if dark { "dark" } else { "default" },
        "securityLevel": "strict",
        "fontFamily": FONT_FAMILY,
        "htmlLabels": false,
        "flowchart": { "htmlLabels": false },
    }));
    let renderer = Renderer::new().with_engine(Engine::new().with_site_config(config));
    let resources = RenderResourcePolicy::interactive()
        .with_limit(ResourceLimitId::MaxSourceBytes, MAX_SOURCE_BYTES)
        .and_then(|policy| policy.with_limit(ResourceLimitId::MaxModelItems, MAX_MODEL_ITEMS))
        .map_err(|error| MermaidRenderError::RenderFailed(error.to_string()))?;
    let request = SvgRequest {
        environment: SvgEnvironment::deterministic().with_resource_policy(resources),
        pipeline: Some(SvgPipeline::resvg_safe()),
        options: SvgRenderOptions {
            // Merman scopes styles and marker IDs to this ID, including in Markdown documents.
            diagram_id: Some(format!(
                "whip-merman-{}",
                DIAGRAM_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            )),
            ..SvgRenderOptions::default()
        },
        ..SvgRequest::default()
    };
    let output = renderer
        .render(RenderRequest::svg(
            source,
            control.with_deadline(RENDER_DEADLINE),
            request,
        ))
        .map_err(|error| MermaidRenderError::RenderFailed(error.to_string()))?;
    match output {
        RenderOutput::Svg(Some(svg)) => Ok(svg.into_parts().0),
        _ => Err(MermaidRenderError::Empty),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(source: &str, dark: bool) -> Result<String, MermaidRenderError> {
        crate::runtime()
            .unwrap()
            .block_on(render_mermaid_svg(source.to_owned(), dark))
    }

    #[test]
    fn renders_common_diagrams_and_preserves_unicode_labels() {
        for source in [
            "flowchart LR\nA[\"中文日本語😀\"] --> B[Done]",
            "sequenceDiagram\nAlice->>Bob: 中文日本語😀",
            "classDiagram\nclass Whip\nWhip : +String name",
            "stateDiagram-v2\n[*] --> Ready\nReady --> [*]",
        ] {
            let svg = preview(source, true).unwrap();
            assert!(svg.contains("<svg"));
            assert!(!svg.contains("<foreignObject"));
        }
        let svg = preview("flowchart LR\nA[\"中文日本語😀\"]", false).unwrap();
        assert!(svg.contains("中文日本語😀"));
        assert!(svg.contains("WhipInter"));
    }

    #[test]
    fn scopes_diagrams_separately_and_uses_the_requested_theme() {
        let source = "flowchart LR\nA --> B";
        let dark = preview(source, true).unwrap();
        let light = preview(source, false).unwrap();
        let id = |svg: &str| {
            let start = svg.find("id=\"").unwrap() + 4;
            svg[start..].split('"').next().unwrap().to_owned()
        };
        assert_ne!(id(&dark), id(&light));
        assert!(dark.contains("fill:#1f2020"));
        assert!(light.contains("fill:#ECECFF"));
    }

    #[test]
    fn rejects_empty_oversized_and_invalid_documents() {
        assert!(matches!(
            preview(" \n", true),
            Err(MermaidRenderError::Empty)
        ));
        assert!(matches!(
            preview(&"中".repeat(MAX_SOURCE_BYTES / 3 + 1), true),
            Err(MermaidRenderError::TooLarge)
        ));
        assert!(preview("flowchart LR\nA[unterminated", true).is_err());
    }

    #[test]
    fn honors_cancellation_before_rendering() {
        let control = OperationControl::new();
        control.cancel();
        assert!(render("flowchart LR\nA --> B", true, control).is_err());
    }

    #[test]
    fn rejects_diagrams_over_the_model_budget_before_layout() {
        let mut source = String::from("flowchart LR\n");
        for index in 0..MAX_MODEL_ITEMS {
            use std::fmt::Write as _;
            writeln!(source, "A{index} --> B{index}").unwrap();
        }
        assert!(preview(&source, true).is_err());
    }
}
