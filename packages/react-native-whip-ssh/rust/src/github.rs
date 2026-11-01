//! GitHub views and conversation replies backed by the connected host's CLI.

use serde::Deserialize;

use crate::remote_ops::shell_quote;
pub(crate) mod checks;
pub(crate) mod counts;
mod markdown;
pub(crate) mod resources;
pub use counts::GithubRepositoryCounts;
pub use markdown::*;
use resources::Commit;
pub use resources::*;

pub(crate) const GITHUB_PAGE_SIZE: usize = 10;
const GITHUB_HOST: &str = "github.com";
pub(crate) const MAX_GITHUB_COMMENT_CHARS: usize = 65_536;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GithubRepository {
    pub directory: String,
    pub name_with_owner: String,
    pub url: String,
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum GithubSection {
    Issues,
    PullRequests,
    Actions,
    Releases,
    Commits,
}

#[derive(Debug, Deserialize, uniffi::Record)]
pub struct GithubRepositoryDetails {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "stargazers_count")]
    pub stars: u32,
    #[serde(rename = "homepage")]
    pub website: Option<String>,
    pub license: Option<GithubLicense>,
    pub allow_merge_commit: Option<bool>,
    pub allow_squash_merge: Option<bool>,
    pub allow_rebase_merge: Option<bool>,
}

#[derive(Debug, Deserialize, uniffi::Record)]
pub struct GithubLicense {
    pub name: String,
    // The repository response's `url` points to the license definition API.
    // Populate this from the license file's html_url instead.
    #[serde(skip)]
    pub url: Option<String>,
}

#[derive(Debug, uniffi::Record)]
pub struct GithubPullRequest {
    pub head_sha: String,
    pub head_branch: String,
    pub base_branch: String,
    pub mergeable: Option<bool>,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub changed_files: Option<u32>,
    pub commits: Option<u32>,
}

#[derive(Debug, uniffi::Record)]
pub struct GithubAuthor {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, uniffi::Record)]
pub struct GithubEntry {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub state: String,
    pub url: String,
    pub body: String,
    pub pull: Option<GithubPullRequest>,
    pub author: Option<GithubAuthor>,
    pub created_at: Option<String>,
}

#[derive(Debug, uniffi::Record)]
pub struct GithubPage {
    pub entries: Vec<GithubEntry>,
    pub has_more: bool,
}

pub(crate) fn discovery_script(directory: &str) -> String {
    // This local probe deliberately requires neither authentication nor network.
    // Run through the host's login shell so Homebrew/Nix installations are found.
    format!(
        "command -v gh >/dev/null 2>&1 || exit 0\ncd {} 2>/dev/null || exit 0\ngit rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0\ngit config --get-regexp '^remote\\..*\\.url$' || true",
        shell_quote(directory),
    )
}

fn github_slug(remote: &str) -> Option<String> {
    let Some(path) = remote.strip_prefix("git@github.com:") else {
        let url = url::Url::parse(remote).ok()?;
        if url.host_str()? != GITHUB_HOST
            || !matches!(url.scheme(), "https" | "http" | "ssh" | "git")
        {
            return None;
        }
        return valid_slug(url.path());
    };
    valid_slug(path)
}

fn valid_slug(path: &str) -> Option<String> {
    let slug = path.trim_matches('/').trim_end_matches(".git");
    let parts: Vec<_> = slug.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        })
    {
        return None;
    }
    Some(slug.to_owned())
}

pub(crate) fn parse_discovery(directory: String, output: &str) -> Option<GithubRepository> {
    let mut remotes: Vec<_> = output
        .lines()
        .filter_map(|line| {
            let (key, remote) = line.split_once(char::is_whitespace)?;
            let priority = match key {
                "remote.origin.url" => 0,
                "remote.upstream.url" => 1,
                _ => 2,
            };
            Some((priority, github_slug(remote.trim())?))
        })
        .collect();
    remotes.sort_by_key(|(priority, _)| *priority);
    let (_, name_with_owner) = remotes.into_iter().next()?;
    Some(GithubRepository {
        directory,
        url: format!("https://{GITHUB_HOST}/{name_with_owner}"),
        name_with_owner,
    })
}

pub(crate) fn api_script(repository: &GithubRepository, endpoint: &str) -> Result<String, String> {
    github_api_script(repository, endpoint, ApiMethod::Get)
}

fn repository_graphql_script(
    repository: &GithubRepository,
    fields: &str,
) -> Result<String, String> {
    if valid_slug(&repository.name_with_owner).as_deref() != Some(&repository.name_with_owner) {
        return Err("Invalid GitHub repository".to_owned());
    }
    let (owner, name) = repository
        .name_with_owner
        .split_once('/')
        .ok_or("Invalid GitHub repository")?;
    let query = format!("query{{repository(owner:\"{owner}\",name:\"{name}\"){{{fields}}}}}");
    Ok(format!(
        "GH_PROMPT_DISABLED=1 GH_PAGER=cat gh api --hostname {GITHUB_HOST} graphql -f {}",
        shell_quote(&format!("query={query}")),
    ))
}

pub(super) enum ApiMethod {
    Get,
    Post,
    Patch,
    Put,
}

fn github_api_script(
    repository: &GithubRepository,
    endpoint: &str,
    method: ApiMethod,
) -> Result<String, String> {
    // Revalidate records coming back across FFI before building an API path.
    if valid_slug(&repository.name_with_owner).as_deref() != Some(&repository.name_with_owner) {
        return Err("Invalid GitHub repository".to_owned());
    }
    let endpoint = format!("repos/{}{}", repository.name_with_owner, endpoint);
    let input = if matches!(method, ApiMethod::Get) {
        ""
    } else {
        " --input -"
    };
    let method = match method {
        ApiMethod::Get => "GET",
        ApiMethod::Post => "POST",
        ApiMethod::Patch => "PATCH",
        ApiMethod::Put => "PUT",
    };
    Ok(format!(
        "GH_PROMPT_DISABLED=1 GH_PAGER=cat gh api --hostname {GITHUB_HOST} --method {method}{input} {}",
        shell_quote(&endpoint),
    ))
}

pub(crate) fn section_endpoint(section: GithubSection, page: u32) -> Result<String, String> {
    if page == 0 {
        return Err("GitHub page numbers start at one".to_owned());
    }
    let path = match section {
        GithubSection::Issues => "issues?state=open&sort=updated&direction=desc&",
        GithubSection::PullRequests => "pulls?state=open&sort=updated&direction=desc&",
        GithubSection::Actions => "actions/runs?",
        GithubSection::Releases => "releases?",
        GithubSection::Commits => "commits?",
    };
    Ok(format!("/{path}per_page={GITHUB_PAGE_SIZE}&page={page}"))
}

pub(crate) fn comments_endpoint(number: u32, page: Option<u32>) -> Result<String, String> {
    if number == 0 || page == Some(0) {
        return Err("Invalid GitHub conversation or page number".to_owned());
    }
    let endpoint = format!("/issues/{number}/comments");
    Ok(match page {
        Some(page) => format!("{endpoint}?per_page={GITHUB_PAGE_SIZE}&page={page}"),
        None => endpoint,
    })
}

pub(crate) fn comment_request(
    repository: &GithubRepository,
    number: u32,
    body: &str,
) -> Result<(String, Vec<u8>), String> {
    if body.trim().is_empty() {
        return Err("Write a comment before posting".to_owned());
    }
    if body.chars().count() > MAX_GITHUB_COMMENT_CHARS {
        return Err("GitHub comments cannot exceed 65536 characters".to_owned());
    }
    let command = github_api_script(
        repository,
        &comments_endpoint(number, None)?,
        ApiMethod::Post,
    )?;
    let payload = serde_json::to_vec(&serde_json::json!({ "body": body }))
        .map_err(|error| format!("Could not encode GitHub comment: {error}"))?;
    Ok((command, payload))
}

#[derive(Deserialize)]
struct Comment {
    id: u64,
    user: User,
    html_url: String,
    body: String,
    created_at: String,
}

impl From<Comment> for GithubEntry {
    fn from(comment: Comment) -> Self {
        Self {
            id: comment.id.to_string(),
            title: comment.user.login.clone(),
            subtitle: comment.created_at.clone(),
            state: String::new(),
            url: comment.html_url,
            body: comment.body,
            pull: None,
            author: Some(GithubAuthor {
                login: comment.user.login,
                avatar_url: comment.user.avatar_url,
            }),
            created_at: Some(comment.created_at),
        }
    }
}

pub(crate) fn parse_comments(output: &[u8]) -> Result<GithubPage, String> {
    let comments: Vec<Comment> = decode(output)?;
    let has_more = comments.len() == GITHUB_PAGE_SIZE;
    Ok(GithubPage {
        entries: comments.into_iter().map(Into::into).collect(),
        has_more,
    })
}

pub(crate) fn parse_comment(output: &[u8]) -> Result<GithubEntry, String> {
    decode::<Comment>(output).map(Into::into)
}

#[derive(Deserialize)]
struct User {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct Issue {
    number: u64,
    title: String,
    user: User,
    state: String,
    html_url: String,
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    pull_request: Option<serde_json::Value>,
    merged_at: Option<String>,
    head: Option<PullBranch>,
    base: Option<PullBranch>,
    mergeable: Option<bool>,
    additions: Option<u32>,
    deletions: Option<u32>,
    changed_files: Option<u32>,
    commits: Option<u32>,
    created_at: Option<String>,
}

#[derive(Deserialize)]
struct PullBranch {
    #[serde(rename = "ref")]
    name: String,
    sha: String,
}

#[derive(Deserialize)]
struct Run {
    id: u64,
    name: Option<String>,
    display_title: String,
    head_branch: Option<String>,
    status: String,
    conclusion: Option<String>,
    html_url: String,
    #[serde(rename = "run_number")]
    number: u64,
}

#[derive(Deserialize)]
struct Runs {
    workflow_runs: Vec<Run>,
}

#[derive(Deserialize)]
struct Release {
    id: u64,
    name: Option<String>,
    tag_name: String,
    html_url: String,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
}

fn decode<T: serde::de::DeserializeOwned>(output: &[u8]) -> Result<T, String> {
    serde_json::from_slice(output).map_err(|error| format!("Invalid GitHub response: {error}"))
}

pub(crate) fn parse_details(output: &[u8]) -> Result<GithubRepositoryDetails, String> {
    let mut details: GithubRepositoryDetails = decode(output)?;
    details.website = details.website.as_deref().and_then(website_url);
    Ok(details)
}

fn website_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let url = url::Url::parse(value)
        .or_else(|_| url::Url::parse(&format!("https://{value}")))
        .ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    Some(url.into())
}

pub(crate) fn parse_license_url(output: &[u8]) -> Result<Option<String>, String> {
    #[derive(Deserialize)]
    struct LicenseFile {
        html_url: Option<String>,
    }
    let file: LicenseFile = decode(output)?;
    Ok(file.html_url.as_deref().and_then(website_url))
}

pub(crate) fn parse_page(section: GithubSection, output: &[u8]) -> Result<GithubPage, String> {
    let (entries, count) = match section {
        GithubSection::Issues | GithubSection::PullRequests => {
            let response: serde_json::Value = decode(output)?;
            let issues: Vec<Issue> =
                serde_json::from_value(response.get("items").cloned().unwrap_or(response))
                    .map_err(|error| format!("Invalid GitHub issues: {error}"))?;
            let count = issues.len();
            let entries = issues
                .into_iter()
                // The REST issues endpoint also includes pull requests.
                .filter(|issue| {
                    !matches!(section, GithubSection::Issues) || issue.pull_request.is_none()
                })
                .map(|issue| GithubEntry {
                    id: issue.number.to_string(),
                    title: issue.title,
                    subtitle: format!("#{} · {}", issue.number, issue.user.login),
                    state: if issue.merged_at.is_some()
                        || issue
                            .pull_request
                            .as_ref()
                            .and_then(|pull| pull.get("merged_at"))
                            .is_some_and(|value| !value.is_null())
                    {
                        "merged".to_owned()
                    } else if issue.draft && issue.state == "open" {
                        "draft".to_owned()
                    } else {
                        issue.state
                    },
                    url: issue.html_url,
                    body: issue.body.unwrap_or_default(),
                    pull: issue
                        .head
                        .zip(issue.base)
                        .map(|(head, base)| GithubPullRequest {
                            head_sha: head.sha,
                            head_branch: head.name,
                            base_branch: base.name,
                            mergeable: issue.mergeable,
                            additions: issue.additions,
                            deletions: issue.deletions,
                            changed_files: issue.changed_files,
                            commits: issue.commits,
                        }),
                    author: Some(GithubAuthor {
                        login: issue.user.login,
                        avatar_url: issue.user.avatar_url,
                    }),
                    created_at: issue.created_at,
                })
                .collect();
            (entries, count)
        }
        GithubSection::Actions => {
            let runs: Runs = decode(output)?;
            let count = runs.workflow_runs.len();
            let entries = runs
                .workflow_runs
                .into_iter()
                .map(|run| GithubEntry {
                    id: run.id.to_string(),
                    title: run.display_title,
                    subtitle: format!(
                        "{} #{} · {}",
                        run.name.unwrap_or_default(),
                        run.number,
                        run.head_branch.unwrap_or_default()
                    ),
                    state: run.conclusion.unwrap_or(run.status),
                    url: run.html_url,
                    body: String::new(),
                    pull: None,
                    author: None,
                    created_at: None,
                })
                .collect();
            (entries, count)
        }
        GithubSection::Releases => {
            let releases: Vec<Release> = decode(output)?;
            let count = releases.len();
            let entries = releases
                .into_iter()
                .map(|release| GithubEntry {
                    id: release.id.to_string(),
                    title: release
                        .name
                        .filter(|name| !name.is_empty())
                        .unwrap_or_else(|| release.tag_name.clone()),
                    subtitle: release.tag_name,
                    state: if release.draft {
                        "draft"
                    } else if release.prerelease {
                        "prerelease"
                    } else {
                        "published"
                    }
                    .to_owned(),
                    url: release.html_url,
                    body: release.body.unwrap_or_default(),
                    pull: None,
                    author: None,
                    created_at: None,
                })
                .collect();
            (entries, count)
        }
        GithubSection::Commits => {
            let commits: Vec<Commit> = decode(output)?;
            let count = commits.len();
            (commits.into_iter().map(Into::into).collect(), count)
        }
    };
    Ok(GithubPage {
        entries,
        has_more: count == GITHUB_PAGE_SIZE,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_github_remotes_and_prefers_origin() {
        for remote in [
            "git@github.com:owner/repo.git",
            "https://github.com/owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
            "git://github.com/owner/repo",
        ] {
            assert_eq!(github_slug(remote).as_deref(), Some("owner/repo"));
        }
        let repo = parse_discovery("/repo".to_owned(), "remote.upstream.url https://github.com/upstream/repo.git\nremote.origin.url git@github.com:owner/repo.git\n").unwrap();
        assert_eq!(repo.name_with_owner, "owner/repo");
        assert_eq!(repo.url, "https://github.com/owner/repo");
    }

    #[test]
    fn hides_non_github_repositories_and_missing_cli() {
        for remote in [
            "https://gitlab.com/owner/repo",
            "https://github.com.evil.test/owner/repo",
            "https://github.com/owner/repo/extra",
            "file:///repo",
            "https://github.com/owner/..",
        ] {
            assert!(github_slug(remote).is_none(), "{remote}");
        }
        assert!(parse_discovery("/repo".to_owned(), "").is_none());
        assert!(
            parse_discovery(
                "/repo".to_owned(),
                "remote.origin.url https://gitlab.com/owner/repo"
            )
            .is_none()
        );
    }

    #[test]
    fn separates_issues_from_pull_requests_and_keeps_pagination() {
        let issue = serde_json::json!({"number":1,"title":"Fix","user":{"login":"octo","html_url":"https://github.com/octo"},"state":"open","html_url":"https://github.com/o/r/issues/1","body":null});
        let mut pr = issue.clone();
        pr["pull_request"] = serde_json::json!({"url":"pull"});
        pr["draft"] = true.into();
        let output = serde_json::to_vec(&vec![pr; GITHUB_PAGE_SIZE]).unwrap();
        let page = parse_page(GithubSection::Issues, &output).unwrap();
        assert!(page.entries.is_empty());
        assert!(page.has_more);
        let page = parse_page(GithubSection::PullRequests, &output).unwrap();
        assert_eq!(page.entries[0].state, "draft");
        assert!(page.entries[0].body.is_empty());
        assert!(
            !parse_page(
                GithubSection::Issues,
                &serde_json::to_vec(&[issue]).unwrap()
            )
            .unwrap()
            .has_more
        );
    }

    #[test]
    fn parses_actions_star_counts_and_release_notes() {
        let page = parse_page(GithubSection::Actions, br#"{"workflow_runs":[{"id":1,"name":"CI","display_title":"Build","head_branch":"main","status":"completed","conclusion":"failure","html_url":"https://github.com/o/r/actions/runs/1","run_number":3}]}"#).unwrap();
        assert_eq!(page.entries[0].state, "failure");
        let page = parse_page(GithubSection::Releases, br##"[{"id":1,"name":"","tag_name":"v1","html_url":"https://github.com/o/r/releases/tag/v1","body":"# Notes","draft":false,"prerelease":true}]"##).unwrap();
        assert_eq!(page.entries[0].title, "v1");
        assert_eq!(page.entries[0].body, "# Notes");
        assert_eq!(page.entries[0].state, "prerelease");
        assert_eq!(
            parse_details(br#"{"description":null,"stargazers_count":42}"#)
                .unwrap()
                .stars,
            42
        );
    }

    #[test]
    fn parses_repository_website_and_license_metadata() {
        let details = parse_details(br#"{"stargazers_count":42,"homepage":" example.com/docs ","license":{"name":"MIT License","url":"https://api.github.com/licenses/mit"}}"#).unwrap();
        assert_eq!(details.website.as_deref(), Some("https://example.com/docs"));
        let license = details.license.unwrap();
        assert_eq!(license.name, "MIT License");
        for output in [
            br#"{"stargazers_count":0}"#.as_slice(),
            br#"{"stargazers_count":0,"homepage":null,"license":null}"#.as_slice(),
        ] {
            let details = parse_details(output).unwrap();
            assert!(details.website.is_none());
            assert!(details.license.is_none());
        }
    }

    #[test]
    fn repository_links_only_accept_web_urls() {
        for value in [
            "",
            "  ",
            "javascript:alert(1)",
            "ftp://example.com",
            "mailto:me@example.com",
        ] {
            assert!(website_url(value).is_none(), "{value}");
        }
        assert_eq!(
            website_url("http://example.com").as_deref(),
            Some("http://example.com/")
        );
        let license_url = "https://github.com/owner/repo/blob/main/COPYING.md";
        let file = serde_json::to_vec(&serde_json::json!({"html_url": license_url})).unwrap();
        assert_eq!(
            parse_license_url(&file).unwrap().as_deref(),
            Some(license_url)
        );
        assert!(
            parse_license_url(br#"{"html_url":null}"#)
                .unwrap()
                .is_none()
        );
        assert!(
            parse_license_url(br#"{"html_url":"javascript:alert(1)"}"#)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rejects_invalid_responses_and_pages() {
        assert!(parse_page(GithubSection::Issues, b"{\"message\":\"Bad credentials\"}").is_err());
        assert!(section_endpoint(GithubSection::Issues, 0).is_err());
    }

    #[test]
    fn comment_requests_preserve_markdown_in_json_stdin() {
        let repository = parse_discovery(
            "/repo".to_owned(),
            "remote.origin.url git@github.com:owner/repo.git",
        )
        .unwrap();
        let body = "**Reply** 👋\n`$(touch nope)` 'quotes' @-";
        let (command, input) = comment_request(&repository, 7, body).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&input).unwrap();
        assert_eq!(payload["body"], body);
        assert!(!command.contains(body));
        assert_eq!(
            command,
            "GH_PROMPT_DISABLED=1 GH_PAGER=cat gh api --hostname github.com --method POST --input - 'repos/owner/repo/issues/7/comments'"
        );
        assert!(comment_request(&repository, 0, body).is_err());
        assert!(comment_request(&repository, 7, " \n ").is_err());
        assert!(
            comment_request(&repository, 7, &"x".repeat(MAX_GITHUB_COMMENT_CHARS + 1)).is_err()
        );
    }

    #[test]
    fn parses_conversation_pages_and_posted_comments() {
        let comment = serde_json::json!({"id":9_007_199_254_740_993_u64,"user":{"login":"octo"},"html_url":"https://github.com/o/r/issues/7#issuecomment-1","body":"**Thanks**","created_at":"2026-10-30T12:00:00Z"});
        let entry = parse_comment(&serde_json::to_vec(&comment).unwrap()).unwrap();
        assert_eq!(entry.id, "9007199254740993");
        assert_eq!(entry.title, "octo");
        assert_eq!(entry.body, "**Thanks**");
        let page =
            parse_comments(&serde_json::to_vec(&vec![comment; GITHUB_PAGE_SIZE]).unwrap()).unwrap();
        assert!(page.has_more);
        assert_eq!(page.entries.len(), GITHUB_PAGE_SIZE);
        assert_eq!(
            comments_endpoint(7, Some(2)).unwrap(),
            "/issues/7/comments?per_page=10&page=2"
        );
        assert!(comments_endpoint(7, Some(0)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn local_probe_requires_both_a_github_remote_and_an_installed_cli() {
        use std::process::Command;

        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("repo ' $(touch injected)");
        let bin = temp.path().join("bin");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec!["remote", "add", "origin", "git@github.com:owner/repo.git"],
        ] {
            let output = Command::new("git")
                .args(args)
                .current_dir(&directory)
                .output()
                .unwrap();
            assert!(output.status.success());
        }
        let git = Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap();
        let git = String::from_utf8(git.stdout).unwrap();
        std::os::unix::fs::symlink(git.trim(), bin.join("git")).unwrap();
        let directory = directory.to_str().unwrap();
        let probe = |path: &str| {
            let output = Command::new("/bin/sh")
                .args(["-c", &discovery_script(path)])
                .env("PATH", &bin)
                .current_dir(temp.path())
                .output()
                .unwrap();
            assert!(output.status.success());
            parse_discovery(path.to_owned(), &String::from_utf8(output.stdout).unwrap())
        };
        assert!(probe(directory).is_none());
        // The probe only needs command discovery; it must never invoke gh.
        std::os::unix::fs::symlink(git.trim(), bin.join("gh")).unwrap();
        assert_eq!(probe(directory).unwrap().name_with_owner, "owner/repo");
        assert!(probe(temp.path().to_str().unwrap()).is_none());
        let output = Command::new("git")
            .args([
                "remote",
                "set-url",
                "origin",
                "https://gitlab.com/owner/repo",
            ])
            .current_dir(directory)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(probe(directory).is_none());
        assert!(!temp.path().join("injected").exists());
    }
}
