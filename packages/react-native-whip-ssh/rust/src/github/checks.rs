use super::resources::{GithubResource, files_endpoint, parse_resource};
use super::{
    GITHUB_HOST, GITHUB_PAGE_SIZE, GithubEntry, GithubPage, GithubRepository, api_script, decode,
};
use crate::remote_ops::shell_quote;
use serde::Deserialize;
use std::collections::HashMap;
use std::fmt::Write;

pub(crate) const CHECKS_UNAVAILABLE: &str = "checks_unavailable";

pub(crate) fn commit_status_script(
    repository: &GithubRepository,
    entries: &[GithubEntry],
) -> Result<String, String> {
    api_script(repository, "")?;
    let (owner, name) = repository
        .name_with_owner
        .split_once('/')
        .ok_or("Invalid GitHub repository")?;
    let mut fields = String::new();
    for (index, entry) in entries.iter().enumerate() {
        files_endpoint(&entry.id, false, 1)?;
        write!(
            fields,
            "c{index}:object(oid:\"{}\"){{... on Commit{{oid statusCheckRollup{{state}}}}}}",
            entry.id
        )
        .map_err(|error| error.to_string())?;
    }
    let query = format!("query{{repository(owner:\"{owner}\",name:\"{name}\"){{{fields}}}}}");
    Ok(format!(
        "GH_PROMPT_DISABLED=1 GH_PAGER=cat gh api --hostname {GITHUB_HOST} graphql -f {}",
        shell_quote(&format!("query={query}")),
    ))
}

#[derive(Deserialize)]
struct Response {
    data: Data,
}

#[derive(Deserialize)]
struct Data {
    repository: HashMap<String, Option<CommitStatus>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitStatus {
    oid: String,
    status_check_rollup: Option<Rollup>,
}

#[derive(Deserialize)]
struct Rollup {
    state: String,
}

pub(crate) fn apply_commit_statuses(
    entries: &mut [GithubEntry],
    output: &[u8],
) -> Result<(), String> {
    let response: Response = decode(output)?;
    for (index, entry) in entries.iter_mut().enumerate() {
        entry.state = response
            .data
            .repository
            .get(&format!("c{index}"))
            .and_then(Option::as_ref)
            .filter(|commit| commit.oid == entry.id)
            .map_or_else(
                || CHECKS_UNAVAILABLE.to_owned(),
                |commit| {
                    commit.status_check_rollup.as_ref().map_or_else(
                        || "no_checks".to_owned(),
                        |rollup| rollup.state.to_lowercase(),
                    )
                },
            );
    }
    Ok(())
}

pub(crate) fn commit_checks_endpoint(sha: &str, page: u32) -> Result<String, String> {
    files_endpoint(sha, false, page)?;
    Ok(format!(
        "/commits/{sha}/check-runs?filter=latest&per_page={GITHUB_PAGE_SIZE}&page={page}"
    ))
}

pub(crate) fn commit_statuses_endpoint(sha: &str, page: u32) -> Result<String, String> {
    files_endpoint(sha, false, page)?;
    Ok(format!(
        "/commits/{sha}/status?per_page={GITHUB_PAGE_SIZE}&page={page}"
    ))
}

#[derive(Deserialize)]
struct Statuses {
    statuses: Vec<Status>,
}

#[derive(Deserialize)]
struct Status {
    id: u64,
    context: String,
    state: String,
    description: Option<String>,
    target_url: Option<String>,
    updated_at: Option<String>,
}

pub(crate) fn parse_commit_checks(checks: &[u8], statuses: &[u8]) -> Result<GithubPage, String> {
    let mut page = parse_resource(GithubResource::CommitChecks, checks)?;
    let statuses: Statuses = decode(statuses)?;
    page.has_more |= statuses.statuses.len() == GITHUB_PAGE_SIZE;
    for entry in &mut page.entries {
        entry.id = format!("check-{}", entry.id);
    }
    page.entries
        .extend(statuses.statuses.into_iter().map(|status| GithubEntry {
            id: format!("status-{}", status.id),
            title: status.context,
            subtitle: status.updated_at.unwrap_or_default(),
            state: status.state,
            url: status.target_url.unwrap_or_default(),
            body: status.description.unwrap_or_default(),
            pull: None,
            author: None,
            created_at: None,
        }));
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::{GithubSection, parse_page};
    use serde_json::json;

    fn commits(count: usize) -> Vec<GithubEntry> {
        let values: Vec<_> = (0..count)
            .map(|index| {
                json!({
                    "sha": format!("{index:040x}"),
                    "html_url": "https://github.com/o/r/commit/sha",
                    "commit": {"message": format!("Commit {index}")},
                })
            })
            .collect();
        parse_page(
            GithubSection::Commits,
            &serde_json::to_vec(&values).unwrap(),
        )
        .unwrap()
        .entries
    }

    #[test]
    fn matches_each_commits_combined_status_and_distinguishes_missing_checks() {
        let mut entries = commits(8);
        let mut values = serde_json::Map::new();
        for (index, state) in [
            Some("SUCCESS"),
            Some("FAILURE"),
            Some("PENDING"),
            None,
            Some("ERROR"),
        ]
        .into_iter()
        .enumerate()
        {
            values.insert(
                format!("c{index}"),
                json!({
                    "oid": entries[index].id,
                    "statusCheckRollup": state.map(|state| json!({"state": state})),
                }),
            );
        }
        values.insert("c5".into(), serde_json::Value::Null);
        values.insert(
            "c6".into(),
            json!({"oid": entries[0].id, "statusCheckRollup": {"state": "SUCCESS"}}),
        );
        let output = serde_json::to_vec(&json!({"data": {"repository": values}})).unwrap();
        apply_commit_statuses(&mut entries, &output).unwrap();
        let states: Vec<_> = entries.iter().map(|entry| entry.state.as_str()).collect();
        assert_eq!(
            states,
            [
                "success",
                "failure",
                "pending",
                "no_checks",
                "error",
                CHECKS_UNAVAILABLE,
                CHECKS_UNAVAILABLE,
                CHECKS_UNAVAILABLE
            ]
        );
        assert_eq!(entries[2].title, "Commit 2");
        assert_eq!(entries[2].id, format!("{:040x}", 2));
        assert!(
            apply_commit_statuses(&mut entries, br#"{"errors":[{"message":"Forbidden"}]}"#)
                .is_err()
        );
        assert_eq!(entries[0].state, "success");
    }

    #[test]
    fn batches_commit_status_queries_and_validates_refs_before_shell_execution() {
        let repository = GithubRepository {
            directory: "/repo".into(),
            name_with_owner: "o/r".into(),
            url: String::new(),
        };
        let mut entries = commits(2);
        let command = commit_status_script(&repository, &entries).unwrap();
        let arguments = shlex::split(&command).unwrap();
        assert_eq!(
            arguments
                .iter()
                .filter(|argument| argument.as_str() == "graphql")
                .count(),
            1
        );
        let query = arguments.last().unwrap();
        for entry in &entries {
            assert!(query.contains(&format!("object(oid:\"{}\")", entry.id)));
        }
        assert!(query.starts_with("query=query{repository(owner:\"o\",name:\"r\")"));
        entries[0].id = "$(touch nope)".into();
        assert!(commit_status_script(&repository, &entries).is_err());
        assert!(commit_checks_endpoint("abcdef1234", 0).is_err());
        assert!(commit_checks_endpoint("../main", 1).is_err());
        assert!(commit_statuses_endpoint("main", 1).is_err());
        assert!(
            commit_checks_endpoint("abcdef1234", 2)
                .unwrap()
                .ends_with("filter=latest&per_page=10&page=2")
        );
    }

    #[test]
    fn shows_check_runs_and_latest_legacy_statuses_without_id_collisions() {
        let checks = br#"{"check_runs":[{"id":1,"name":"Build","status":"completed","conclusion":"failure","html_url":"https://github.com/o/r/actions/runs/1/job/1","app":{"name":"GitHub Actions"},"output":{"summary":"Build failed"}},{"id":2,"name":"Lint","status":"queued"}]}"#;
        let statuses = br#"{"statuses":[{"id":1,"context":"external-ci","state":"pending","description":"Running","target_url":"https://ci.example.com/1"}]}"#;
        let page = parse_commit_checks(checks, statuses).unwrap();
        assert_eq!(page.entries.len(), 3);
        assert_eq!(page.entries[0].id, "check-1");
        assert_eq!(page.entries[0].state, "failure");
        assert!(page.entries[0].body.contains("Build failed"));
        assert_eq!(page.entries[1].state, "queued");
        assert_eq!(page.entries[2].id, "status-1");
        assert_eq!(page.entries[2].state, "pending");
        assert_eq!(page.entries[2].url, "https://ci.example.com/1");
        assert!(!page.has_more);
        assert!(parse_commit_checks(checks, b"{}").is_err());
    }

    #[test]
    fn paginates_checks_and_legacy_statuses_independently() {
        for (checks_count, statuses_count, expected) in
            [(0, 0, false), (9, 9, false), (10, 0, true), (0, 10, true)]
        {
            let checks: Vec<_> = (0..checks_count)
                .map(|id| json!({"id": id, "name": "Build", "status": "queued"}))
                .collect();
            let statuses: Vec<_> = (0..statuses_count)
                .map(|id| json!({"id": id, "context": "CI", "state": "pending"}))
                .collect();
            let page = parse_commit_checks(
                &serde_json::to_vec(&json!({"check_runs": checks})).unwrap(),
                &serde_json::to_vec(&json!({"statuses": statuses})).unwrap(),
            )
            .unwrap();
            assert_eq!(page.has_more, expected);
            assert_eq!(page.entries.len(), checks_count + statuses_count);
        }
    }
}
