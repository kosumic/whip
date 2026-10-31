use super::herdr_setup::login_shell_command;
use super::remote_files::{command_failure, execute_generation_checked, resolved_remote_path};
use super::{HostRuntime, HostRuntimeError, current_generation, current_ssh, validate_generation};
use crate::github::checks::{
    CHECKS_UNAVAILABLE, apply_commit_statuses, commit_status_script, commit_statuses_endpoint,
    parse_commit_checks,
};
use crate::github::resources::{
    asset_script, checks_endpoint, files_endpoint, list_script, mutation_request, parse_files,
    parse_resource, positive_id, resource_endpoint, validate_merge_response,
};
use crate::github::{
    GithubEntry, GithubFilesPage, GithubListState, GithubMutation, GithubPage, GithubRepository,
    GithubRepositoryDetails, GithubResource, GithubSection, api_script, comment_request,
    comments_endpoint, discovery_script, parse_comment, parse_comments, parse_details,
    parse_discovery, parse_license_url, parse_page,
};
use std::time::Duration;

#[uniffi::export]
impl HostRuntime {
    pub async fn discover_github_repository(
        &self,
        path: String,
    ) -> Result<Option<GithubRepository>, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let directory = resolved_remote_path(&inner, Some(&path)).await?;
                validate_generation(&inner, generation)?;
                let command = login_shell_command(&discovery_script(&directory));
                let output = execute_generation_checked(&inner, &command).await?;
                validate_generation(&inner, generation)?;
                if output.exit_status != Some(0) || output.stdout_truncated {
                    return Err(HostRuntimeError::GitFailure(command_failure(
                        "GitHub discovery",
                        &output,
                    )));
                }
                Ok(parse_discovery(
                    directory,
                    &String::from_utf8_lossy(&output.stdout),
                ))
            })
            .await
            .map_err(|error| {
                HostRuntimeError::GitFailure(format!("GitHub discovery task failed: {error}"))
            })?
    }

    pub async fn github_repository_details(
        &self,
        repository: GithubRepository,
    ) -> Result<GithubRepositoryDetails, HostRuntimeError> {
        let output = self.github_read(repository.clone(), String::new()).await?;
        let mut details = parse_details(&output).map_err(HostRuntimeError::GitFailure)?;
        if let Some(license) = &mut details.license {
            // Keep this optional lookup in the same cached details request. A
            // missing or inaccessible license file must not hide other metadata.
            if let Ok(output) = self.github_read(repository, "/license".to_owned()).await {
                license.url = parse_license_url(&output).ok().flatten();
            }
        }
        Ok(details)
    }

    pub async fn github_page(
        &self,
        repository: GithubRepository,
        section: GithubSection,
        page: u32,
        state: GithubListState,
        query: String,
    ) -> Result<GithubPage, HostRuntimeError> {
        let command = list_script(&repository, section, page, state, &query)
            .map_err(HostRuntimeError::GitFailure)?;
        let output = self.github_read_command(command).await?;
        let mut result = parse_page(section, &output).map_err(HostRuntimeError::GitFailure)?;
        if matches!(section, GithubSection::Commits) {
            self.github_commit_statuses(&repository, &mut result).await;
        }
        Ok(result)
    }

    pub async fn github_comments(
        &self,
        repository: GithubRepository,
        number: u32,
        page: u32,
    ) -> Result<GithubPage, HostRuntimeError> {
        let endpoint =
            comments_endpoint(number, Some(page)).map_err(HostRuntimeError::GitFailure)?;
        let output = self.github_read(repository, endpoint).await?;
        parse_comments(&output).map_err(HostRuntimeError::GitFailure)
    }

    pub async fn github_post_comment(
        &self,
        repository: GithubRepository,
        number: u32,
        body: String,
    ) -> Result<GithubEntry, HostRuntimeError> {
        let (command, payload) =
            comment_request(&repository, number, &body).map_err(HostRuntimeError::GitFailure)?;
        let output = self.github_write(command, payload).await?;
        parse_comment(&output).map_err(|error| HostRuntimeError::GitFailure(format!("GitHub accepted the comment, but its response could not be read. Refresh the conversation. {error}")))
    }

    pub async fn github_files(
        &self,
        repository: GithubRepository,
        id: String,
        pull: bool,
        page: u32,
    ) -> Result<GithubFilesPage, HostRuntimeError> {
        let endpoint = files_endpoint(&id, pull, page).map_err(HostRuntimeError::GitFailure)?;
        let output = self.github_read(repository, endpoint).await?;
        parse_files(&output, pull).map_err(HostRuntimeError::GitFailure)
    }

    pub async fn github_entry(
        &self,
        repository: GithubRepository,
        section: GithubSection,
        id: String,
    ) -> Result<GithubEntry, HostRuntimeError> {
        let path = match section {
            GithubSection::Issues => format!(
                "/issues/{}",
                positive_id(&id).map_err(HostRuntimeError::GitFailure)?
            ),
            GithubSection::PullRequests => format!(
                "/pulls/{}",
                positive_id(&id).map_err(HostRuntimeError::GitFailure)?
            ),
            GithubSection::Actions => format!(
                "/actions/runs/{}",
                positive_id(&id).map_err(HostRuntimeError::GitFailure)?
            ),
            GithubSection::Releases => format!(
                "/releases/{}",
                positive_id(&id).map_err(HostRuntimeError::GitFailure)?
            ),
            GithubSection::Commits => {
                files_endpoint(&id, false, 1).map_err(HostRuntimeError::GitFailure)?
            }
        };
        let output = self.github_read(repository.clone(), path).await?;
        let value: serde_json::Value = serde_json::from_slice(&output)
            .map_err(|e| HostRuntimeError::GitFailure(e.to_string()))?;
        let wrapped = if matches!(section, GithubSection::Actions) {
            serde_json::json!({"workflow_runs": [value]})
        } else {
            serde_json::json!([value])
        };
        let mut result = parse_page(
            section,
            &serde_json::to_vec(&wrapped)
                .map_err(|e| HostRuntimeError::GitFailure(e.to_string()))?,
        )
        .map_err(HostRuntimeError::GitFailure)?;
        if matches!(section, GithubSection::Commits) {
            self.github_commit_statuses(&repository, &mut result).await;
        }
        result
            .entries
            .into_iter()
            .next()
            .ok_or_else(|| HostRuntimeError::GitFailure("GitHub item no longer exists".to_owned()))
    }

    pub async fn github_resource(
        &self,
        repository: GithubRepository,
        resource: GithubResource,
        id: String,
        page: u32,
    ) -> Result<GithubPage, HostRuntimeError> {
        let endpoint =
            resource_endpoint(resource, &id, page).map_err(HostRuntimeError::GitFailure)?;
        let mut output = self.github_read(repository.clone(), endpoint).await?;
        if matches!(resource, GithubResource::CommitChecks) {
            let endpoint =
                commit_statuses_endpoint(&id, page).map_err(HostRuntimeError::GitFailure)?;
            let statuses = self.github_read(repository, endpoint).await?;
            return parse_commit_checks(&output, &statuses).map_err(HostRuntimeError::GitFailure);
        }
        if matches!(resource, GithubResource::PullChecks) {
            let endpoint = checks_endpoint(&output, page).map_err(HostRuntimeError::GitFailure)?;
            output = self.github_read(repository.clone(), endpoint).await?;
        }
        let mut result = parse_resource(resource, &output).map_err(HostRuntimeError::GitFailure)?;
        if matches!(resource, GithubResource::PullCommits) {
            self.github_commit_statuses(&repository, &mut result).await;
        }
        Ok(result)
    }

    pub async fn github_mutate(
        &self,
        repository: GithubRepository,
        action: GithubMutation,
        id: String,
        title: String,
        body: String,
        expected_head: String,
    ) -> Result<Option<GithubEntry>, HostRuntimeError> {
        let (command, payload) =
            mutation_request(&repository, action, &id, &title, &body, &expected_head)
                .map_err(HostRuntimeError::GitFailure)?;
        let output = self.github_write(command, payload).await?;
        if matches!(
            action,
            GithubMutation::CreateIssue
                | GithubMutation::CloseIssue
                | GithubMutation::ReopenIssue
                | GithubMutation::ClosePull
                | GithubMutation::ReopenPull
        ) {
            let page = parse_page(
                if matches!(action, GithubMutation::ClosePull | GithubMutation::ReopenPull) { GithubSection::PullRequests } else { GithubSection::Issues },
                &[b"[", output.as_slice(), b"]"].concat(),
            )
            .map_err(|error| HostRuntimeError::GitFailure(format!("GitHub accepted the action, but its response could not be read. Refresh before retrying. {error}")))?;
            return Ok(page.entries.into_iter().next());
        }
        if matches!(
            action,
            GithubMutation::MergePull | GithubMutation::SquashPull | GithubMutation::RebasePull
        ) {
            validate_merge_response(&output).map_err(HostRuntimeError::GitFailure)?;
        }
        Ok(None)
    }

    pub async fn github_prepare_asset(
        &self,
        repository: GithubRepository,
        id: String,
        name: String,
    ) -> Result<String, HostRuntimeError> {
        let command = login_shell_command(
            &asset_script(&repository, &id, &name).map_err(HostRuntimeError::GitFailure)?,
        );
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let ssh = current_ssh(&inner)?;
                validate_generation(&inner, generation)?;
                let output = tokio::time::timeout(Duration::from_secs(300), ssh.execute(&command))
                    .await
                    .map_err(|_| {
                        HostRuntimeError::GitFailure("GitHub asset download timed out".to_owned())
                    })?
                    .map_err(|e| HostRuntimeError::SshTransportFailure(e.to_string()))?;
                validate_generation(&inner, generation)?;
                if output.exit_status != Some(0) {
                    return Err(HostRuntimeError::GitFailure(command_failure(
                        "GitHub asset download",
                        &output,
                    )));
                }
                let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                if !path.starts_with('/')
                    || !path.contains("/whip-github.")
                    || output.stdout_truncated
                {
                    return Err(HostRuntimeError::GitFailure(
                        "Invalid GitHub asset download path".to_owned(),
                    ));
                }
                Ok(path)
            })
            .await
            .map_err(|e| {
                HostRuntimeError::GitFailure(format!("GitHub asset download failed: {e}"))
            })?
    }
}

impl HostRuntime {
    async fn github_commit_statuses(&self, repository: &GithubRepository, page: &mut GithubPage) {
        if page.entries.is_empty() {
            return;
        }
        // Optional metadata must not prevent browsing commits when checks are
        // unavailable (for example, with a restricted GitHub token).
        for entry in &mut page.entries {
            CHECKS_UNAVAILABLE.clone_into(&mut entry.state);
        }
        if let Ok(command) = commit_status_script(repository, &page.entries)
            && let Ok(output) = self.github_read_command(command).await
        {
            let _ = apply_commit_statuses(&mut page.entries, &output);
        }
    }

    async fn github_write(
        &self,
        command: String,
        payload: Vec<u8>,
    ) -> Result<Vec<u8>, HostRuntimeError> {
        let command = login_shell_command(&command);
        let inner = self.inner.clone();
        crate::runtime().map_err(HostRuntimeError::SshTransportFailure)?.spawn(async move {
            let generation = current_generation(&inner)?;
            let ssh = current_ssh(&inner)?;
            validate_generation(&inner, generation)?;
            // Mutations execute once. The body goes over stdin, never shell arguments.
            let output = tokio::time::timeout(Duration::from_secs(30), ssh.execute_with_input(&command, &payload)).await
                .map_err(|_| HostRuntimeError::GitFailure("Could not confirm the GitHub action. Refresh before retrying.".to_owned()))?
                .map_err(|error| HostRuntimeError::GitFailure(format!("Could not confirm the GitHub action. Refresh before retrying. {error}")))?;
            if output.exit_status != Some(0) {
                return Err(HostRuntimeError::GitFailure(command_failure("GitHub action", &output)));
            }
            // Acknowledged writes remain successful even if the host reconnects.
            if output.stdout_truncated {
                    return Err(HostRuntimeError::GitFailure("GitHub accepted the action, but its response was truncated. Refresh the view.".to_owned()));
            }
            Ok(output.stdout)
        }).await.map_err(|error| HostRuntimeError::GitFailure(format!("GitHub action task failed: {error}")))?
    }
    async fn github_read(
        &self,
        repository: GithubRepository,
        endpoint: String,
    ) -> Result<Vec<u8>, HostRuntimeError> {
        self.github_read_command(
            api_script(&repository, &endpoint).map_err(HostRuntimeError::GitFailure)?,
        )
        .await
    }

    async fn github_read_command(&self, command: String) -> Result<Vec<u8>, HostRuntimeError> {
        let command = login_shell_command(&command);
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let output = execute_generation_checked(&inner, &command).await?;
                if output.exit_status != Some(0) {
                    return Err(HostRuntimeError::GitFailure(command_failure(
                        "GitHub", &output,
                    )));
                }
                if output.stdout_truncated {
                    return Err(HostRuntimeError::GitFailure(
                        "GitHub response exceeded the command limit".to_owned(),
                    ));
                }
                Ok(output.stdout)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::GitFailure(format!("GitHub read task failed: {error}"))
            })?
    }
}
