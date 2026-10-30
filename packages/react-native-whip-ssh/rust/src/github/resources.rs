use super::{
    ApiMethod, GITHUB_HOST, GITHUB_PAGE_SIZE, GithubEntry, GithubPage, GithubRepository,
    GithubSection, MAX_GITHUB_COMMENT_CHARS, User, api_script, decode, github_api_script,
    section_endpoint,
};
use crate::remote_ops::shell_quote;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum GithubListState {
    Open,
    Closed,
    All,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum GithubResource {
    PullCommits,
    PullReviews,
    PullChecks,
    RunJobs,
    JobLogs,
    ReleaseAssets,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum GithubMutation {
    CreateIssue,
    CloseIssue,
    ReopenIssue,
    ClosePull,
    ReopenPull,
    MergePull,
    SquashPull,
    RebasePull,
    ApprovePull,
    RequestChanges,
    RerunAction,
    RerunFailedJobs,
    CancelAction,
}

#[derive(Debug, Deserialize, uniffi::Record)]
pub struct GithubFile {
    #[serde(rename = "filename")]
    pub path: String,
    pub previous_filename: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub patch: Option<String>,
}

#[derive(Debug, uniffi::Record)]
pub struct GithubFilesPage {
    pub files: Vec<GithubFile>,
    pub has_more: bool,
}

#[uniffi::export]
pub async fn github_file_diff(
    file: GithubFile,
) -> Result<crate::git_review::GitDiffReview, crate::host_runtime::HostRuntimeError> {
    use crate::host_runtime::HostRuntimeError;
    crate::runtime()
        .map_err(HostRuntimeError::GitFailure)?
        .spawn_blocking(move || prepare_file_diff(file).map_err(HostRuntimeError::GitFailure))
        .await
        .map_err(|e| HostRuntimeError::GitFailure(e.to_string()))?
}

fn prepare_file_diff(file: GithubFile) -> Result<crate::git_review::GitDiffReview, String> {
    let patch = file
        .patch
        .ok_or("GitHub did not provide a text patch for this file")?;
    let old = serde_json::to_string(&format!(
        "a/{}",
        file.previous_filename.as_deref().unwrap_or(&file.path)
    ))
    .map_err(|e| e.to_string())?;
    let new = serde_json::to_string(&format!("b/{}", file.path)).map_err(|e| e.to_string())?;
    let patch = format!("diff --git {old} {new}\n--- {old}\n+++ {new}\n{patch}\n");
    let diff = crate::remote_ops::parse_git_diff(patch.as_bytes())?;
    Ok(crate::git_review::review_file(
        diff,
        crate::remote_ops::GitDiffContext::Full,
        &[],
        &file.path,
    ))
}

#[derive(Deserialize)]
pub(super) struct Commit {
    sha: String,
    html_url: String,
    #[serde(rename = "commit")]
    data: CommitData,
    author: Option<User>,
}

#[derive(Deserialize)]
struct CommitData {
    message: String,
    author: Option<CommitAuthor>,
}
#[derive(Deserialize)]
struct CommitAuthor {
    name: String,
    date: String,
}

impl From<Commit> for GithubEntry {
    fn from(value: Commit) -> Self {
        let author = value
            .author
            .map(|a| a.login)
            .or_else(|| value.data.author.as_ref().map(|a| a.name.clone()))
            .unwrap_or_default();
        let date = value.data.author.map(|a| a.date).unwrap_or_default();
        let subtitle = format!(
            "{} · {author} · {date}",
            value.sha.get(..7).unwrap_or(&value.sha)
        );
        Self {
            id: value.sha,
            title: value
                .data
                .message
                .lines()
                .next()
                .unwrap_or_default()
                .to_owned(),
            subtitle,
            state: String::new(),
            url: value.html_url,
            body: value.data.message,
            pull: None,
            author: None,
            created_at: None,
        }
    }
}

pub(crate) fn list_script(
    repository: &GithubRepository,
    section: GithubSection,
    page: u32,
    state: GithubListState,
    query: &str,
) -> Result<String, String> {
    let endpoint = section_endpoint(section, page)?;
    let state = match state {
        GithubListState::Open => "open",
        GithubListState::Closed => "closed",
        GithubListState::All => "all",
    };
    if matches!(section, GithubSection::Issues | GithubSection::PullRequests) {
        if !query.trim().is_empty() {
            // Keep repo/type/state constraints outside user input, so search stays scoped.
            let kind = if matches!(section, GithubSection::Issues) {
                "issue"
            } else {
                "pr"
            };
            let state = if state == "all" {
                String::new()
            } else {
                format!(" state:{state}")
            };
            let search = format!(
                "{} repo:{} is:{kind}{state}",
                query.trim(),
                repository.name_with_owner
            );
            // Validate the FFI repository even though this is a global API endpoint.
            api_script(repository, "")?;
            let parameters = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("q", &search)
                .append_pair("sort", "updated")
                .append_pair("order", "desc")
                .append_pair("per_page", &GITHUB_PAGE_SIZE.to_string())
                .append_pair("page", &page.to_string())
                .finish();
            return Ok(format!(
                "GH_PROMPT_DISABLED=1 GH_PAGER=cat gh api --hostname {GITHUB_HOST} --method GET {}",
                shell_quote(&format!("search/issues?{parameters}"))
            ));
        }
        return api_script(
            repository,
            &endpoint.replace("state=open", &format!("state={state}")),
        );
    }
    let key = match section {
        GithubSection::Commits => Some("sha"),
        GithubSection::Actions => Some("branch"),
        _ => None,
    };
    let endpoint = match key.filter(|_| !query.trim().is_empty()) {
        Some(key) => format!(
            "{endpoint}&{}",
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair(key, query.trim())
                .finish()
        ),
        None => endpoint,
    };
    api_script(repository, &endpoint)
}

pub(crate) fn positive_id(id: &str) -> Result<u64, String> {
    id.parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| "Invalid GitHub identifier".to_owned())
}

pub(crate) fn files_endpoint(id: &str, pull: bool, page: u32) -> Result<String, String> {
    if page == 0 {
        return Err("Invalid GitHub page".to_owned());
    }
    let path = if pull {
        format!("pulls/{}/files", positive_id(id)?)
    } else {
        if !(7..=64).contains(&id.len()) || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid commit SHA".to_owned());
        }
        format!("commits/{id}")
    };
    Ok(format!("/{path}?per_page={GITHUB_PAGE_SIZE}&page={page}"))
}

pub(crate) fn parse_files(output: &[u8], pull: bool) -> Result<GithubFilesPage, String> {
    let value: Value = decode(output)?;
    let files: Vec<GithubFile> = serde_json::from_value(if pull {
        value
    } else {
        value.get("files").cloned().unwrap_or(json!([]))
    })
    .map_err(|e| format!("Invalid changed files: {e}"))?;
    let has_more = files.len() == GITHUB_PAGE_SIZE;
    Ok(GithubFilesPage { files, has_more })
}

pub(crate) fn resource_endpoint(
    resource: GithubResource,
    id: &str,
    page: u32,
) -> Result<String, String> {
    if page == 0 {
        return Err("Invalid GitHub page".to_owned());
    }
    let id = positive_id(id)?;
    let path = match resource {
        GithubResource::PullCommits => format!("pulls/{id}/commits"),
        GithubResource::PullReviews => format!("pulls/{id}/reviews"),
        GithubResource::PullChecks => format!("pulls/{id}"), // Resolve the current head SHA before fetching checks.
        GithubResource::RunJobs => format!("actions/runs/{id}/jobs"),
        GithubResource::JobLogs => return Ok(format!("/actions/jobs/{id}/logs")),
        GithubResource::ReleaseAssets => format!("releases/{id}/assets"),
    };
    Ok(format!("/{path}?per_page={GITHUB_PAGE_SIZE}&page={page}"))
}

fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}
fn state(value: &Value) -> String {
    value["conclusion"]
        .as_str()
        .unwrap_or_else(|| value["status"].as_str().unwrap_or_default())
        .to_owned()
}

pub(crate) fn parse_resource(
    resource: GithubResource,
    output: &[u8],
) -> Result<GithubPage, String> {
    if matches!(resource, GithubResource::PullCommits) {
        return super::parse_page(GithubSection::Commits, output);
    }
    if matches!(resource, GithubResource::JobLogs) {
        return Ok(GithubPage {
            entries: vec![GithubEntry {
                id: "logs".to_owned(),
                title: String::new(),
                subtitle: String::new(),
                state: String::new(),
                url: String::new(),
                body: String::from_utf8_lossy(output).into_owned(),
                pull: None,
                author: None,
                created_at: None,
            }],
            has_more: false,
        });
    }
    let value: Value = decode(output)?;
    let key = match resource {
        GithubResource::RunJobs => Some("jobs"),
        GithubResource::PullChecks => Some("check_runs"),
        _ => None,
    };
    let list = key
        .map_or(&value, |key| &value[key])
        .as_array()
        .ok_or("Invalid GitHub resource list")?;
    let has_more = list.len() == GITHUB_PAGE_SIZE;
    let entries = list
        .iter()
        .map(|v| {
            let (title, subtitle, status, body, url) = match resource {
                GithubResource::PullReviews => (
                    string(&v["user"], "login"),
                    string(v, "submitted_at"),
                    string(v, "state").to_lowercase(),
                    string(v, "body"),
                    string(v, "html_url"),
                ),
                GithubResource::RunJobs => {
                    let steps = v["steps"]
                        .as_array()
                        .map(|steps| {
                            steps
                                .iter()
                                .map(|s| {
                                    format!("{}. {} · {}", s["number"], string(s, "name"), state(s))
                                })
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    (
                        string(v, "name"),
                        string(v, "started_at"),
                        state(v),
                        steps,
                        string(v, "html_url"),
                    )
                }
                GithubResource::PullChecks => (
                    string(v, "name"),
                    string(&v["app"], "name"),
                    state(v),
                    format!(
                        "{}\n\n{}",
                        string(&v["output"], "summary"),
                        string(&v["output"], "text")
                    ),
                    string(v, "html_url"),
                ),
                GithubResource::ReleaseAssets => (
                    string(v, "name"),
                    format!("{} bytes · {} downloads", v["size"], v["download_count"]),
                    string(v, "state"),
                    String::new(),
                    string(v, "browser_download_url"),
                ),
                GithubResource::JobLogs | GithubResource::PullCommits => unreachable!(),
            };
            GithubEntry {
                id: v["id"].as_u64().unwrap_or_default().to_string(),
                title,
                subtitle,
                state: status,
                body,
                url,
                pull: None,
                author: None,
                created_at: None,
            }
        })
        .collect();
    Ok(GithubPage { entries, has_more })
}

pub(crate) fn checks_endpoint(output: &[u8], page: u32) -> Result<String, String> {
    let value: Value = decode(output)?;
    let sha = value["head"]["sha"]
        .as_str()
        .ok_or("Missing pull request head")?;
    files_endpoint(sha, false, page)?; // Validate the API-derived ref before interpolating it.
    Ok(format!(
        "/commits/{sha}/check-runs?per_page={GITHUB_PAGE_SIZE}&page={page}"
    ))
}

pub(crate) fn mutation_request(
    repository: &GithubRepository,
    action: GithubMutation,
    id: &str,
    title: &str,
    body: &str,
    expected_head: &str,
) -> Result<(String, Vec<u8>), String> {
    let number = if matches!(action, GithubMutation::CreateIssue) {
        0
    } else {
        positive_id(id)?
    };
    if body.chars().count() > MAX_GITHUB_COMMENT_CHARS {
        return Err("GitHub text cannot exceed 65536 characters".to_owned());
    }
    let (endpoint, method, payload) = match action {
        GithubMutation::CreateIssue => {
            if title.trim().is_empty() || title.chars().count() > 256 {
                return Err("Enter an issue title of up to 256 characters".to_owned());
            }
            (
                "/issues".to_owned(),
                ApiMethod::Post,
                json!({"title": title.trim(), "body": body}),
            )
        }
        GithubMutation::CloseIssue | GithubMutation::ReopenIssue => (
            format!("/issues/{number}"),
            ApiMethod::Patch,
            json!({"state": if matches!(action, GithubMutation::CloseIssue) { "closed" } else { "open" }}),
        ),
        GithubMutation::ClosePull | GithubMutation::ReopenPull => (
            format!("/pulls/{number}"),
            ApiMethod::Patch,
            json!({"state": if matches!(action, GithubMutation::ClosePull) { "closed" } else { "open" }}),
        ),
        GithubMutation::MergePull | GithubMutation::SquashPull | GithubMutation::RebasePull => {
            if !matches!(expected_head.len(), 40 | 64)
                || !expected_head.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err(
                    "Refresh the pull request before merging: a full head commit SHA is required"
                        .to_owned(),
                );
            }
            let method = match action {
                GithubMutation::SquashPull => "squash",
                GithubMutation::RebasePull => "rebase",
                _ => "merge",
            };
            (
                format!("/pulls/{number}/merge"),
                ApiMethod::Put,
                json!({"merge_method": method, "sha": expected_head}),
            )
        }
        GithubMutation::ApprovePull | GithubMutation::RequestChanges => {
            if matches!(action, GithubMutation::RequestChanges) && body.trim().is_empty() {
                return Err("Explain the requested changes before submitting".to_owned());
            }
            (
                format!("/pulls/{number}/reviews"),
                ApiMethod::Post,
                json!({"event": if matches!(action, GithubMutation::ApprovePull) { "APPROVE" } else { "REQUEST_CHANGES" }, "body": body}),
            )
        }
        GithubMutation::RerunAction => (
            format!("/actions/runs/{number}/rerun"),
            ApiMethod::Post,
            json!({}),
        ),
        GithubMutation::RerunFailedJobs => (
            format!("/actions/runs/{number}/rerun-failed-jobs"),
            ApiMethod::Post,
            json!({}),
        ),
        GithubMutation::CancelAction => (
            format!("/actions/runs/{number}/cancel"),
            ApiMethod::Post,
            json!({}),
        ),
    };
    let command = github_api_script(repository, &endpoint, method)?;
    Ok((
        command,
        serde_json::to_vec(&payload).map_err(|e| e.to_string())?,
    ))
}

pub(crate) fn validate_merge_response(output: &[u8]) -> Result<(), String> {
    #[derive(Deserialize)]
    struct MergeResult {
        merged: bool,
        message: String,
    }
    let response: MergeResult = decode(output).map_err(|error| {
        format!(
            "Could not confirm the merge result. Refresh the pull request before retrying. {error}"
        )
    })?;
    if !response.merged {
        return Err(format!("Pull request was not merged: {}", response.message));
    }
    Ok(())
}

pub(crate) fn asset_script(
    repository: &GithubRepository,
    id: &str,
    name: &str,
) -> Result<String, String> {
    let id = positive_id(id)?;
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', '\0', '\n', '\r'])
    {
        return Err("Invalid asset filename".to_owned());
    }
    let command = api_script(repository, &format!("/releases/assets/{id}"))?;
    Ok(format!(
        "umask 077\nwhip_asset_dir=$(mktemp -d \"${{TMPDIR:-/tmp}}/whip-github.XXXXXXXX\") || exit 1\ntrap 'rm -rf -- \"$whip_asset_dir\"' EXIT HUP INT TERM\n{command} -H 'Accept: application/octet-stream' >\"$whip_asset_dir\"/{} || exit 1\nprintf '%s/%s\\n' \"$whip_asset_dir\" {}\ntrap - EXIT HUP INT TERM",
        shell_quote(name),
        shell_quote(name)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::parse_page;
    fn repository() -> GithubRepository {
        GithubRepository {
            directory: "/repo".into(),
            name_with_owner: "o/r".into(),
            url: "https://github.com/o/r".into(),
        }
    }
    #[test]
    fn commits_and_changed_files_preserve_sha_patch_and_rename() {
        let result = parse_page(GithubSection::Commits, br#"[{"sha":"abcdef1234","html_url":"https://github.com/o/r/commit/abcdef1234","commit":{"message":"Fix bug\n\nDetails","author":{"name":"Octo","date":"2026-10-30"}},"author":null}]"#).unwrap();
        assert_eq!(result.entries[0].id, "abcdef1234");
        assert_eq!(result.entries[0].title, "Fix bug");
        assert!(result.entries[0].body.contains("Details"));
        let files = parse_files(br#"{"files":[{"filename":"new.rs","previous_filename":"old.rs","status":"renamed","additions":1,"deletions":1,"patch":"@@ -1 +1 @@\n-old\n+new"}]}"#, false).unwrap();
        assert_eq!(files.files[0].previous_filename.as_deref(), Some("old.rs"));
        assert!(files.files[0].patch.as_ref().unwrap().contains("+new"));
        assert!(files_endpoint("main; whoami", false, 1).is_err());
        assert!(files_endpoint("0", true, 1).is_err());
        let diff = prepare_file_diff(files.files.into_iter().next().unwrap()).unwrap();
        assert_eq!(diff.diff.additions, 1);
        assert_eq!(diff.diff.deletions, 1);
        assert!(
            diff.diff
                .rows
                .iter()
                .any(|row| row.content == "new" && row.new_line == Some(1))
        );
    }
    #[test]
    fn routes_mutations_once_with_user_text_only_in_stdin() {
        let body = "`$(touch never)`\n**review**";
        let (command, payload) = mutation_request(
            &repository(),
            GithubMutation::RequestChanges,
            "42",
            "",
            body,
            "",
        )
        .unwrap();
        assert!(command.contains("pulls/42/reviews"));
        assert!(!command.contains(body));
        assert_eq!(
            serde_json::from_slice::<Value>(&payload).unwrap()["event"],
            "REQUEST_CHANGES"
        );
        assert!(
            mutation_request(
                &repository(),
                GithubMutation::RequestChanges,
                "42",
                "",
                " ",
                ""
            )
            .is_err()
        );
        assert!(asset_script(&repository(), "1", "../bad").is_err());
        assert!(
            asset_script(&repository(), "1", "whip's.apk")
                .unwrap()
                .contains("application/octet-stream")
        );
    }
    #[test]
    fn jobs_checks_and_assets_are_native_resources() {
        let jobs = parse_resource(GithubResource::RunJobs, br#"{"jobs":[{"id":4,"name":"Android","status":"completed","conclusion":"failure","steps":[{"number":1,"name":"Build","status":"completed","conclusion":"failure"}]}]}"#).unwrap();
        assert_eq!(jobs.entries[0].state, "failure");
        assert!(jobs.entries[0].body.contains("Build"));
        let checks = parse_resource(GithubResource::PullChecks, br#"{"check_runs":[{"id":5,"name":"CI","status":"queued","app":{"name":"Actions"},"output":{"summary":"waiting"}}]}"#).unwrap();
        assert_eq!(checks.entries[0].state, "queued");
        assert!(checks.entries[0].body.contains("waiting"));
        let search = list_script(
            &repository(),
            GithubSection::Issues,
            2,
            GithubListState::Closed,
            "hello $(x)",
        )
        .unwrap();
        assert!(search.contains("search/issues?"));
        assert!(search.contains("state%3Aclosed"));
        assert!(!search.contains("$(x)"));
    }

    #[test]
    fn pull_operations_use_correct_methods_and_require_the_reviewed_head() {
        let sha = "a".repeat(40);
        for (action, method) in [
            (GithubMutation::MergePull, "merge"),
            (GithubMutation::SquashPull, "squash"),
            (GithubMutation::RebasePull, "rebase"),
        ] {
            let (command, payload) =
                mutation_request(&repository(), action, "42", "", "", &sha).unwrap();
            assert!(command.contains("--method PUT --input -"));
            assert!(command.ends_with("'repos/o/r/pulls/42/merge'"));
            assert_eq!(
                serde_json::from_slice::<Value>(&payload).unwrap(),
                json!({"sha": sha, "merge_method": method})
            );
            assert!(mutation_request(&repository(), action, "42", "", "", "").is_err());
            assert!(
                mutation_request(&repository(), action, "42", "", "", &"z".repeat(40)).is_err()
            );
        }
        for (action, state) in [
            (GithubMutation::ClosePull, "closed"),
            (GithubMutation::ReopenPull, "open"),
        ] {
            let (command, payload) =
                mutation_request(&repository(), action, "42", "", "", "").unwrap();
            assert!(command.contains("--method PATCH --input -"));
            assert!(command.ends_with("'repos/o/r/pulls/42'"));
            assert_eq!(
                serde_json::from_slice::<Value>(&payload).unwrap()["state"],
                state
            );
        }
        assert!(validate_merge_response(br#"{"merged":true,"message":"Merged"}"#).is_ok());
        assert!(
            validate_merge_response(br#"{"merged":false,"message":"Branch protection"}"#)
                .unwrap_err()
                .contains("Branch protection")
        );
        assert!(
            validate_merge_response(b"")
                .unwrap_err()
                .contains("Refresh")
        );
    }

    #[test]
    fn pull_details_keep_branches_head_and_merged_state() {
        let page = parse_page(GithubSection::PullRequests, br#"[{"number":42,"title":"Change","user":{"login":"octo"},"state":"closed","html_url":"https://github.com/o/r/pull/42","body":"","merged_at":"2026-10-30","draft":true,"head":{"ref":"feature","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"base":{"ref":"main","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"mergeable":true}]"#).unwrap();
        assert_eq!(page.entries[0].state, "merged");
        let pull = page.entries[0].pull.as_ref().unwrap();
        assert_eq!(pull.head_branch, "feature");
        assert_eq!(pull.base_branch, "main");
        assert_eq!(pull.head_sha, "a".repeat(40));
    }

    #[cfg(unix)]
    #[test]
    fn asset_downloads_preserve_binary_content_and_clean_up_failed_requests() {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let temp = tempfile::tempdir().unwrap();
        let cli = temp.path().join("gh");
        std::fs::write(&cli, "#!/bin/sh\nprintf 'asset\\000data'\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = format!(
            "{}:{}",
            temp.path().display(),
            std::env::var("PATH").unwrap()
        );
        let download = |name| {
            Command::new("/bin/sh")
                .args(["-c", &asset_script(&repository(), "1", name).unwrap()])
                .env("PATH", &path)
                .env("TMPDIR", temp.path())
                .current_dir(temp.path())
                .output()
                .unwrap()
        };
        let output = download("whip's $(touch injected).apk");
        assert!(output.status.success());
        let remote = String::from_utf8(output.stdout).unwrap();
        let file = std::path::Path::new(remote.trim());
        assert_eq!(std::fs::read(file).unwrap(), b"asset\0data");
        assert_eq!(
            std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&cli, "#!/bin/sh\nprintf 'partial'\nexit 1\n").unwrap();
        assert!(!download("failed.apk").status.success());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1); // Only the fake CLI remains.
    }
}
