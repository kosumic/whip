//! NSH's direct Rust face of Whip. The mobile archive REPLACES the core-only
//! archive at the existing native link site; never link both archives.
use nsh_core::prelude::*;

/// Stateless About services. No AppCore, HostRuntime or Tokio runtime is created
/// here. Stateful migrations must receive the host's existing Arc<AppCore>.
#[module]
pub struct WhipAbout;

#[module]
impl WhipAbout {
    /// The supported protocol label from the same Rust implementation RN uses.
    pub fn protocol_label() -> String {
        whip_core::herdr_protocol_label()
    }

    /// Validate and compare a GitHub response with the core's version rules.
    pub fn evaluate_update(installed: String, release: String) -> Result<String, String> {
        let result = whip_core::evaluate_app_update(installed, release)
            .map_err(|error| error.to_string())?;
        // Return the core's result without reproducing its comparison rules.
        Ok(format!(
            "{{\"latestVersion\":\"{}\",\"updateAvailable\":{}}}",
            result.latest_version, result.update_available
        ))
    }
}

/// Generated NSH module and TypeScript declarations.
#[native_module("whip/about")]
fn native(registry: &mut Registry) {
    registry.module::<WhipAbout>();
}

/// Called before creating the first mobile surface, in the host's library image.
#[cfg(feature = "mobile")]
#[unsafe(no_mangle)]
pub extern "C" fn whip_nsh_initialize() {
    static INITIALIZED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    INITIALIZED.get_or_init(|| {
        let handle = whip_core::shared_runtime_handle().expect("Whip task runtime starts");
        nsh_engine::set_shared_runtime(handle).expect("Whip initializes NSH before its first view");
    });
    let sets = vec![nsh_base::registry(), registry()];
    #[cfg(target_os = "ios")]
    nsh_platform_ios::set_ui_sets(sets);
    #[cfg(target_os = "android")]
    nsh::set_ui_sets(sets);
}

#[cfg(all(feature = "mobile", target_os = "android"))]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_whipssh_WhipNshViews_initialize(
    _: nsh::jni::JNIEnv<'_>,
    _: nsh::jni::objects::JObject<'_>,
) {
    whip_nsh_initialize();
}

#[cfg(test)]
mod tests {
    use super::WhipAbout;

    #[test]
    fn calls_the_existing_core_protocol_function() {
        assert_eq!(
            WhipAbout::protocol_label(),
            whip_core::herdr_protocol_label()
        );
        assert!(!WhipAbout::protocol_label().is_empty());
    }

    #[test]
    fn uses_core_version_validation_and_numeric_comparison() {
        let release = r#"{"tag_name":"v1.10.0","draft":false,"prerelease":false}"#;
        let result = WhipAbout::evaluate_update("1.9.9".into(), release.into());
        assert_eq!(
            result.as_deref(),
            Ok(r#"{"latestVersion":"1.10.0","updateAvailable":true}"#)
        );
        assert!(WhipAbout::evaluate_update("unknown".into(), release.into()).is_err());
        assert!(WhipAbout::evaluate_update("1.9.9".into(), "{}".into()).is_err());
    }
}
