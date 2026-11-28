//! Project only changes and inspections acknowledged by a successful result.
use super::super::{
    content::bounded,
    images::viewed_image,
    model::{AgentFileDiff, AgentScalarValue, AgentToolState, AgentTranscriptPart},
    projection::is_prompt_image,
};
use serde_json::Value;

fn field<'a>(state: &'a AgentToolState, names: &[&str]) -> Option<&'a str> {
    state.input.iter().find_map(|f| match &f.value {
        AgentScalarValue::String { value } if names.contains(&f.key.as_str()) => {
            Some(value.as_str())
        }
        _ => None,
    })
}

fn append_edit(patch: &mut String, before: &str, after: &str) {
    if !patch.is_empty() {
        patch.push('\n');
    }
    for (prefix, text) in [('-', before), ('+', after)] {
        for line in text.lines() {
            patch.push(prefix);
            patch.push_str(line);
            patch.push('\n');
        }
    }
}

fn enabled(state: &AgentToolState, key: &str) -> bool {
    state
        .input
        .iter()
        .any(|f| f.key == key && matches!(f.value, AgentScalarValue::Boolean { value: true }))
}

fn reported_counts(output: &str) -> Option<(u32, u32)> {
    let (_, counts) = output
        .lines()
        .find(|s| s.starts_with("Made ") && s.ends_with(" lines)."))?
        .rsplit_once(" (+")?;
    let (add, delete) = counts.strip_suffix(" lines).")?.split_once("/-")?;
    Some((add.parse().ok()?, delete.parse().ok()?))
}

pub(super) fn project_success(
    tool: &str,
    state: &mut AgentToolState,
    id: &str,
) -> Option<AgentTranscriptPart> {
    let path = field(state, &["Path", "TargetFile", "AbsolutePath", "ImagePath"])?;
    if tool == "view_image" || (matches!(tool, "read_file" | "view_file") && is_prompt_image(path))
    {
        state.viewed_images = vec![viewed_image(Some(path), None)];
        return None;
    }
    let write = matches!(tool, "write_file" | "write_to_file" | "create_file");
    if !write
        && !matches!(
            tool,
            "edit_file" | "replace_file_content" | "multi_replace_file_content"
        )
    {
        return None;
    }
    let content = field(state, &["Content", "CodeContent"]);
    let append = write && enabled(state, "Append");
    let artifact = enabled(state, "IsArtifact") || field(state, &["ArtifactMetadata"]).is_some();
    let plan =
        (write && !append && artifact && path.rsplit('/').next() == Some("implementation_plan.md"))
            .then(|| {
                content.map(|text| AgentTranscriptPart::Plan {
                    id: format!("{id}:plan"),
                    text: text.to_owned(),
                    timestamp_ms: state.completed_at_ms,
                })
            })
            .flatten();
    let recorded_patch = state
        .output
        .as_deref()
        .and_then(|s| s.split_once("[diff_block_start]"))
        .and_then(|(_, s)| s.split_once("[diff_block_end]"))
        .map(|(s, _)| s.trim_matches(['\r', '\n']).to_owned());
    let patch = recorded_patch.or_else(|| {
        let mut patch = String::new();
        if append {
            append_edit(&mut patch, "", content?);
        } else if let (Some(before), Some(after)) = (
            field(state, &["Target", "TargetContent"]),
            field(state, &["Replacement", "ReplacementContent"]),
        ) {
            append_edit(&mut patch, before, after);
        } else if let Some(chunks) = field(state, &["ReplacementChunks"])
            .and_then(|s| serde_json::from_str::<Vec<Value>>(s).ok())
        {
            for chunk in chunks {
                append_edit(
                    &mut patch,
                    chunk["TargetContent"].as_str()?,
                    chunk["ReplacementContent"].as_str()?,
                );
            }
        }
        (!patch.is_empty()).then(|| bounded(patch.trim_end_matches('\n')))
    });
    let counts = state.output.as_deref().and_then(reported_counts);
    state.files = vec![AgentFileDiff::normalized(
        path.to_owned(),
        patch,
        None,
        content.filter(|_| write && !append).map(str::to_owned),
        counts.map(|(add, _)| add),
        counts.map(|(_, delete)| delete),
    )];
    plan
}
