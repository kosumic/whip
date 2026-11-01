#![cfg_attr(feature = "transport", doc = include_str!("../README.md"))]
#![cfg_attr(
    not(feature = "transport"),
    doc = "Offline Tailcat address validation, without network or runtime dependencies."
)]

mod address;
#[cfg(feature = "transport")]
mod derp;
#[cfg(feature = "transport")]
mod protocol;
#[cfg(feature = "transport")]
mod runtime;
#[cfg(feature = "transport")]
mod transport;

#[cfg(all(test, feature = "transport"))]
mod test_relay;

#[cfg(feature = "transport")]
pub use transport::*;

use std::io;

/// Validate the complete compact `tc…` encoding without contacting a relay.
/// The address contains access credentials and is never included in errors.
pub fn validate_address(address: &str) -> io::Result<()> {
    parse_address(address).map(|_| ())
}

fn parse_address(address: &str) -> io::Result<address::ConnInfo> {
    let info =
        address::parse_addr(address.trim()).map_err(|_| invalid("Invalid Tailcat address"))?;
    if info.server_public == [0; 32]
        || info.server_disco_public.is_none_or(|key| key == [0; 32])
        || info.region.len() > 1
        || (info.region.is_empty() && info.region_id <= 0)
    {
        return Err(invalid(
            "Tailcat address requires server, discovery key, and DERP region",
        ));
    }
    Ok(info)
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod validation_tests {
    use super::validate_address;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ciborium::Value;

    fn address(server_key: Vec<u8>, discovery_key: Option<Vec<u8>>, region: i64) -> String {
        let mut fields = vec![
            (Value::Text("p".into()), Value::Bytes(server_key)),
            (Value::Text("i".into()), Value::Integer(region.into())),
        ];
        if let Some(key) = discovery_key {
            fields.push((Value::Text("k".into()), Value::Bytes(key)));
        }
        let mut bytes = Vec::new();
        ciborium::ser::into_writer(&Value::Map(fields), &mut bytes).unwrap();
        format!("tc{}", URL_SAFE_NO_PAD.encode(bytes))
    }

    #[test]
    fn validates_keys_and_relay_without_transport() {
        assert!(validate_address(&address(vec![1; 32], Some(vec![2; 32]), 1)).is_ok());
        for invalid in [
            "tcYWJj".into(),
            address(vec![0; 32], Some(vec![2; 32]), 1),
            address(vec![1; 31], Some(vec![2; 32]), 1),
            address(vec![1; 32], None, 1),
            address(vec![1; 32], Some(vec![0; 32]), 1),
            address(vec![1; 32], Some(vec![2; 32]), 0),
        ] {
            let error = validate_address(&invalid).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
            assert!(!error.to_string().contains(&invalid));
        }
    }
}
