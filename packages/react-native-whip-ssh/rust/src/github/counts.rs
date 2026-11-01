use super::{GithubRepository, decode, repository_graphql_script};
use serde::Deserialize;

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct GithubRepositoryCounts {
    pub open_issues: u32,
    pub open_pull_requests: u32,
}

pub(crate) fn counts_script(repository: &GithubRepository) -> Result<String, String> {
    repository_graphql_script(
        repository,
        "issues(states:[OPEN]){totalCount} pullRequests(states:[OPEN]){totalCount}",
    )
}

#[derive(Deserialize)]
struct Response {
    data: Data,
}

#[derive(Deserialize)]
struct Data {
    repository: RepositoryCounts,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryCounts {
    issues: Count,
    pull_requests: Count,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Count {
    total_count: u32,
}

pub(crate) fn parse_counts(output: &[u8]) -> Result<GithubRepositoryCounts, String> {
    let response: Response = decode(output)?;
    let repository = response.data.repository;
    Ok(GithubRepositoryCounts {
        open_issues: repository.issues.total_count,
        open_pull_requests: repository.pull_requests.total_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_separate_open_totals_without_fetching_list_pages() {
        let repository = GithubRepository {
            directory: "/repo".into(),
            name_with_owner: "owner/repo".into(),
            url: String::new(),
        };
        let arguments = shlex::split(&counts_script(&repository).unwrap()).unwrap();
        assert_eq!(
            arguments.last().unwrap(),
            "query=query{repository(owner:\"owner\",name:\"repo\"){issues(states:[OPEN]){totalCount} pullRequests(states:[OPEN]){totalCount}}}",
        );
        let invalid = GithubRepository {
            name_with_owner: "owner/$(touch nope)".into(),
            ..repository
        };
        assert!(counts_script(&invalid).is_err());
    }

    #[test]
    fn preserves_full_totals_and_zero_counts() {
        let counts = parse_counts(
            br#"{"data":{"repository":{"issues":{"totalCount":1250},"pullRequests":{"totalCount":0}}}}"#,
        )
        .unwrap();
        assert_eq!(
            counts,
            GithubRepositoryCounts {
                open_issues: 1250,
                open_pull_requests: 0,
            },
        );
    }

    #[test]
    fn unavailable_or_partial_counts_are_not_reported_as_zero() {
        for output in [
            br#"{"data":{"repository":null},"errors":[{"message":"Not found"}]}"#.as_slice(),
            br#"{"data":{"repository":{"issues":{"totalCount":8},"pullRequests":null}}}"#,
            br#"{"errors":[{"message":"Forbidden"}]}"#,
        ] {
            assert!(parse_counts(output).is_err());
        }
    }
}
