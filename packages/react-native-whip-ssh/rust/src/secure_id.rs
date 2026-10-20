use uuid::Uuid;

#[uniffi::export]
pub fn create_secure_id(prefix: String) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_ids_preserve_the_prefix_and_use_random_v4_uuids() -> Result<(), uuid::Error> {
        let prefix = "known-host";
        let first = create_secure_id(prefix.to_owned());
        let second = create_secure_id(prefix.to_owned());
        let uuid = Uuid::parse_str(
            first
                .strip_prefix(&format!("{prefix}-"))
                .unwrap_or_default(),
        )?;

        assert_eq!(uuid.get_version(), Some(uuid::Version::Random));
        assert_eq!(uuid.get_variant(), uuid::Variant::RFC4122);
        assert_eq!(first, format!("{prefix}-{uuid}"));
        assert_ne!(first, second);
        Ok(())
    }
}
