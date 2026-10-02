//! Validate GitHub's latest release and compare it with the installed app.

use semver::Version;
use serde::Deserialize;

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct AppUpdateCheck {
    pub latest_version: String,
    pub update_available: bool,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum AppUpdateError {
    #[error("The installed app version is invalid")]
    InvalidInstalledVersion,
    #[error("GitHub returned an invalid stable release")]
    InvalidRelease,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

#[uniffi::export]
pub fn evaluate_app_update(
    installed_version: String,
    release_json: String,
) -> Result<AppUpdateCheck, AppUpdateError> {
    let installed =
        Version::parse(&installed_version).map_err(|_| AppUpdateError::InvalidInstalledVersion)?;
    let release: GithubRelease =
        serde_json::from_str(&release_json).map_err(|_| AppUpdateError::InvalidRelease)?;
    let latest = Version::parse(
        release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name),
    )
    .map_err(|_| AppUpdateError::InvalidRelease)?;
    if release.draft || release.prerelease || !latest.pre.is_empty() {
        return Err(AppUpdateError::InvalidRelease);
    }
    Ok(AppUpdateCheck {
        latest_version: latest.to_string(),
        update_available: latest.cmp_precedence(&installed).is_gt(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(installed: &str, tag: &str) -> Result<AppUpdateCheck, AppUpdateError> {
        evaluate_app_update(
            installed.into(),
            serde_json::json!({"tag_name": tag, "draft": false, "prerelease": false}).to_string(),
        )
    }

    #[test]
    fn compares_versions_numerically_and_ignores_build_metadata() -> Result<(), AppUpdateError> {
        for (installed, latest, expected) in [
            ("1.7.6", "v1.7.7", true),
            ("1.9.9", "v1.10.0", true),
            ("1.7.6", "1.7.6", false),
            ("1.8.0", "v1.7.6", false),
            ("1.7.6+local", "v1.7.6+release", false),
            ("1.7.6-rc.1", "v1.7.6", true),
        ] {
            assert_eq!(check(installed, latest)?.update_available, expected);
        }
        assert_eq!(check("1.7.6", "v1.7.7")?.latest_version, "1.7.7");
        Ok(())
    }

    #[test]
    fn rejects_unusable_versions_and_unpublished_releases() {
        assert!(matches!(
            check("unknown", "v1.7.7"),
            Err(AppUpdateError::InvalidInstalledVersion)
        ));
        for tag in ["whipair-v1.7.7", "v1.7", "v1.7.7-beta.1"] {
            assert!(matches!(
                check("1.7.6", tag),
                Err(AppUpdateError::InvalidRelease)
            ));
        }
        for response in [
            "not json",
            r#"{"message":"Not Found"}"#,
            r#"{"tag_name":"v1.7.7","draft":true,"prerelease":false}"#,
            r#"{"tag_name":"v1.7.7","draft":false,"prerelease":true}"#,
        ] {
            assert!(matches!(
                evaluate_app_update("1.7.6".into(), response.into()),
                Err(AppUpdateError::InvalidRelease)
            ));
        }
    }
}
