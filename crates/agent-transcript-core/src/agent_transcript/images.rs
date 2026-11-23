//! Bounded image inspection metadata. Never stringify opaque result payloads.
use serde_json::Value;

use super::model::{
    AgentField, AgentMessageRole, AgentScalarValue, AgentToolState, AgentToolStatus,
    AgentTranscriptPart, AgentViewedImage,
};

const MAX_IMAGES: usize = 8;
const MAX_SOURCE_BYTES: usize = 8 * 1024;
const MAX_INLINE_BYTES: usize = 64 * 1024;
pub(crate) const VIEW_IMAGE_TOOL: &str = "view_image";

pub(crate) fn image_source(source: &str) -> Option<String> {
    if source
        .strip_prefix("file://")
        .is_some_and(|path| !path.starts_with('/'))
    {
        return None;
    }
    if source.contains(':')
        && !["data:image/", "https://", "http://", "file://"]
            .iter()
            .any(|prefix| source.starts_with(prefix))
    {
        return None;
    }
    let limit = if source.starts_with("data:image/") {
        MAX_INLINE_BYTES
    } else {
        MAX_SOURCE_BYTES
    };
    (!source.trim().is_empty() && source.len() <= limit).then(|| source.to_owned())
}

pub(crate) fn resolve_sources(images: &mut [AgentViewedImage], directory: Option<&str>) {
    let Some(directory) = directory else {
        return;
    };
    for image in images {
        if let Some(source) = &image.source
            && !source.starts_with('/')
            && !source.contains(':')
            && !source.starts_with('~')
        {
            image.source = image_source(&format!("{}/{source}", directory.trim_end_matches('/')));
        }
    }
}

pub(crate) fn resolve_message_sources(
    message: &mut super::model::AgentTranscriptMessage,
    directory: Option<&str>,
) {
    for part in &mut message.parts {
        if let AgentTranscriptPart::Tool { state, .. } = part {
            resolve_sources(&mut state.viewed_images, directory);
        }
    }
}

pub(crate) fn viewed_image(source: Option<&str>, label: Option<&str>) -> AgentViewedImage {
    let label = label
        .or(source.filter(|source| !source.starts_with("data:")))
        .filter(|label| !label.trim().is_empty() && label.len() <= MAX_SOURCE_BYTES)
        .unwrap_or("Image")
        .to_owned();
    AgentViewedImage {
        label,
        source: source.and_then(image_source),
    }
}

/// Claude source blocks, Pi image blocks and OpenCode FilePart attachments.
/// Only known containers are traversed, with a shared count/inline-byte budget.
pub(crate) fn result_images(value: &Value) -> Vec<AgentViewedImage> {
    fn visit(value: &Value, images: &mut Vec<AgentViewedImage>, budget: &mut usize, depth: u8) {
        if depth > 4 || images.len() >= MAX_IMAGES {
            return;
        }
        if let Some(blocks) = value.as_array() {
            for block in blocks.iter().take(super::content::MAX_BLOCKS) {
                visit(block, images, budget, depth + 1);
            }
            return;
        }
        let mime = value["mime"]
            .as_str()
            .or_else(|| value["mimeType"].as_str())
            .or_else(|| value["source"]["media_type"].as_str())
            .or_else(|| value["file"]["type"].as_str());
        let kind = value["type"].as_str();
        let is_image = kind == Some("image")
            || (kind == Some("file") && mime.is_some_and(|mime| mime.starts_with("image/")));
        if is_image {
            let source = value["url"]
                .as_str()
                .or_else(|| value["uri"].as_str())
                .or_else(|| value["source"]["url"].as_str())
                .or_else(|| value["path"].as_str());
            let mut image = viewed_image(
                source,
                value["filename"]
                    .as_str()
                    .or_else(|| value["name"].as_str()),
            );
            // Claude's rich Read result uses file.base64; Pi uses data.
            let data = value["source"]["data"]
                .as_str()
                .or_else(|| value["data"].as_str())
                .or_else(|| value["file"]["base64"].as_str());
            if image.source.is_none()
                && let (Some(data), Some(mime)) = (data, mime)
                && mime.starts_with("image/")
                && mime.len() < 128
                && !data.is_empty()
                && data.len().saturating_add(mime.len() + 13) <= *budget
            {
                let uri = format!("data:{mime};base64,{data}");
                *budget -= uri.len();
                image.source = Some(uri);
            }
            if let Some(uri) = &image.source
                && uri.starts_with("data:")
                && source.is_some()
            {
                if uri.len() > *budget {
                    image.source = None;
                } else {
                    *budget -= uri.len();
                }
            }
            images.push(image);
            return;
        }
        for key in ["content", "attachments"] {
            if let Some(child) = value.get(key) {
                visit(child, images, budget, depth + 1);
            }
        }
    }
    let mut images = Vec::new();
    let mut budget = MAX_INLINE_BYTES;
    visit(value, &mut images, &mut budget, 0);
    images
}

pub(crate) fn image_tool_part(
    id: String,
    image: AgentViewedImage,
    at: Option<u64>,
) -> AgentTranscriptPart {
    AgentTranscriptPart::Tool {
        call_id: id.clone(),
        id,
        tool: VIEW_IMAGE_TOOL.into(),
        timestamp_ms: at,
        state: AgentToolState {
            status: AgentToolStatus::Completed,
            input: Vec::new(),
            input_json: None,
            output: None,
            error: None,
            title: None,
            started_at_ms: at,
            completed_at_ms: at,
            exit_code: None,
            duration_ms: None,
            files: Vec::new(),
            diagnostics: Vec::new(),
            loaded: Vec::new(),
            questions: Vec::new(),
            viewed_images: vec![image],
        },
    }
}

pub(crate) fn assistant_image_part(
    part: AgentTranscriptPart,
    role: AgentMessageRole,
) -> AgentTranscriptPart {
    if role == AgentMessageRole::Assistant
        && let AgentTranscriptPart::Image {
            id,
            source,
            timestamp_ms,
        } = part
    {
        return image_tool_part(id, viewed_image(Some(&source), None), timestamp_ms);
    }
    part
}

/// An input path is only a fallback after structured evidence of an image read.
/// Never turn an ordinary read or an image generator into an inspection.
pub(crate) fn inspected_images(
    tool: &str,
    input: &[AgentField],
    images: &[AgentViewedImage],
) -> Vec<AgentViewedImage> {
    if !matches!(tool.to_ascii_lowercase().as_str(), "read" | VIEW_IMAGE_TOOL) {
        return Vec::new();
    }
    let path = input.iter().find_map(|field| {
        if matches!(field.key.as_str(), "path" | "file_path" | "filePath")
            && let AgentScalarValue::String { value } = &field.value
        {
            Some(value.as_str())
        } else {
            None
        }
    });
    images
        .iter()
        .map(|image| {
            let mut image = image.clone();
            if images.len() == 1
                && let Some(path) = path
            {
                image.label = viewed_image(None, Some(path)).label;
                if image.source.is_none() {
                    image.source = image_source(path);
                }
            }
            image
        })
        .collect()
}
