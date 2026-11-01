use super::*;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ciborium::Value;
use proptest::prelude::*;
use qrcode::{EcLevel, QrCode};

fn payload() -> PairingPayload {
    PairingPayload {
        ssh_host: "100.64.0.2".into(),
        tailcat: false,
        ssh_port: 22,
        ssh_user: "alice".into(),
        temporary_private_key_seed: [7; 32],
        ssh_host_key_sha256: [9; 32],
    }
}

#[test]
fn pairing_code_round_trips() {
    let payload = payload();
    let code = encode_pairing_code(&payload).unwrap();
    assert!(code.starts_with(ENVELOPE_PREFIX));
    assert_eq!(code.len(), 120);
    let qr = QrCode::with_error_correction_level(code.as_bytes(), EcLevel::L).unwrap();
    assert_eq!(qr.width(), 37);
    assert_eq!(decode_pairing_code(&code).unwrap(), payload);
}

#[test]
fn pairing_code_round_trips_ipv6_and_hostname() {
    for ssh_host in ["fd7a:115c:a1e0::1", "host.example.test"] {
        let mut payload = payload();
        payload.ssh_host = ssh_host.into();
        let code = encode_pairing_code(&payload).unwrap();
        assert!(code.len() <= 145);
        assert_eq!(decode_pairing_code(&code).unwrap(), payload);
    }
}

#[test]
fn matches_fixed_ipv4_ipv6_and_hostname_vectors() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/wp4-pairing.json")).unwrap();
    for vector in fixture["cases"].as_array().unwrap() {
        let mut payload = payload();
        payload.ssh_host = vector["ssh_host"].as_str().unwrap().into();
        let code = vector["code"].as_str().unwrap();
        assert_eq!(encode_pairing_code(&payload).unwrap(), code);
        assert_eq!(decode_pairing_code(code).unwrap(), payload);
    }
    assert!(matches!(
        decode_pairing_code(fixture["trailingDataCode"].as_str().unwrap()),
        Err(ProtocolError::TrailingData)
    ));
    assert!(matches!(
        decode_pairing_code(fixture["malformedTailcatCode"].as_str().unwrap()),
        Err(ProtocolError::BadPayload(_))
    ));
}

#[test]
fn tailcat_code_matches_the_mobile_scanner_fixture() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/tailcat-pairing.json")).unwrap();
    let mut payload = payload();
    payload.tailcat = true;
    for (address_field, code_field) in [("address", "code"), ("longAddress", "longCode")] {
        payload.ssh_host = fixture[address_field].as_str().unwrap().into();
        let code = encode_pairing_code(&payload).unwrap();
        assert_eq!(code, fixture[code_field].as_str().unwrap());
        assert_eq!(decode_pairing_code(&code).unwrap(), payload);
        assert!(QrCode::with_error_correction_level(code.as_bytes(), EcLevel::L).is_ok());
    }
}

#[test]
fn tailcat_addresses_must_fit_the_qr() {
    let mut payload = payload();
    payload.tailcat = true;
    payload.ssh_host = format!(
        "tc{}",
        URL_SAFE_NO_PAD.encode([1; MAX_TAILCAT_ADDRESS_BYTES])
    );
    assert!(encode_pairing_code(&payload).is_err());
    for address in ["", "tc", "tc!!!!", "host.example.test", "tcYWJj\n"] {
        assert!(validate_tailcat_address(address).is_err());
    }
}

#[test]
fn pairing_code_rejects_another_version() {
    assert!(matches!(
        decode_pairing_code("WP3:BB8"),
        Err(ProtocolError::BadPrefix)
    ));
}

#[test]
fn pairing_code_rejects_truncated_data() {
    let code = format!("{ENVELOPE_PREFIX}00");
    assert!(matches!(
        decode_pairing_code(&code),
        Err(ProtocolError::BadEncoding)
    ));
}

#[test]
fn base45_matches_rfc_vectors() {
    for (plain, encoded) in [
        ("AB", "BB8"),
        ("Hello!!", "%69 VD92EX0"),
        ("base-45", "UJCLQE7W581"),
    ] {
        assert_eq!(base45_encode(plain.as_bytes()), encoded);
        assert_eq!(base45_decode(encoded).unwrap(), plain.as_bytes());
    }
}

#[test]
fn base45_rejects_invalid_or_overflowing_input() {
    for encoded in ["0", "ab", ":::"] {
        assert!(matches!(
            base45_decode(encoded),
            Err(ProtocolError::BadEncoding)
        ));
    }
}

#[test]
fn parses_a_real_ed25519_public_blob() {
    let mut blob = Vec::new();
    blob.extend_from_slice(&(11_u32.to_be_bytes()));
    blob.extend_from_slice(b"ssh-ed25519");
    blob.extend_from_slice(&(32_u32.to_be_bytes()));
    blob.extend_from_slice(&[7_u8; 32]);
    let line = format!(
        "ssh-ed25519 {} prototype device",
        base64::engine::general_purpose::STANDARD.encode(blob)
    );
    let key = validate_public_key(&line).unwrap();
    assert_eq!(key.canonical_line(), line);
    assert!(fingerprint_public_key(&key).starts_with("SHA256:"));
}

#[test]
fn formats_a_six_digit_verification_code() {
    let mut digest = [0_u8; 32];
    digest[..4].copy_from_slice(&0x1234_5678_u32.to_be_bytes());
    assert_eq!(verification_code_sha256(&digest), "419-896");
}

#[test]
fn verification_code_matches_the_phone_implementation() {
    let key = validate_public_key(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti phone",
    )
    .unwrap();
    assert_eq!(verification_code_public_key(&key).unwrap(), "610-862");
}

#[test]
fn accepts_other_public_key_algorithms_understood_by_russh_key_parser() {
    let ecdsa = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc= ecdsa@example";
    let security_key = "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAINSoElFleH+nN83FoLqqepJjN+y7Gs5lrn7qXjBqQZyuAAAABHNzaDo= token@example";
    let mut rsa_blob = Vec::new();
    append_ssh_field(&mut rsa_blob, b"ssh-rsa");
    append_ssh_field(&mut rsa_blob, &[1, 0, 1]);
    let mut modulus = vec![0_u8, 0x80];
    modulus.extend_from_slice(&[0x5a; 255]);
    append_ssh_field(&mut rsa_blob, &modulus);
    let rsa = format!(
        "ssh-rsa {} rsa@example",
        base64::engine::general_purpose::STANDARD.encode(rsa_blob)
    );
    for line in [ecdsa, security_key, &rsa] {
        let key = validate_public_key(line).unwrap();
        assert_eq!(key.canonical_line(), line);
        assert!(fingerprint_public_key(&key).starts_with("SHA256:"));
    }
}

fn append_ssh_field(encoded: &mut Vec<u8>, value: &[u8]) {
    encoded.extend_from_slice(&u32::try_from(value.len()).unwrap().to_be_bytes());
    encoded.extend_from_slice(value);
}

#[test]
fn rejects_authorized_key_options() {
    let line = "restrict ssh-ed25519 AAAA";
    assert!(matches!(
        validate_public_key(line),
        Err(ProtocolError::UnsupportedKey)
    ));
}

#[test]
fn rejects_terminal_control_characters_in_comments() {
    let mut blob = Vec::new();
    blob.extend_from_slice(&(11_u32.to_be_bytes()));
    blob.extend_from_slice(b"ssh-ed25519");
    blob.extend_from_slice(&(32_u32.to_be_bytes()));
    blob.extend_from_slice(&[9_u8; 32]);
    let line = format!(
        "ssh-ed25519 {} device\u{1b}[2J",
        base64::engine::general_purpose::STANDARD.encode(blob)
    );
    assert!(matches!(
        validate_public_key(&line),
        Err(ProtocolError::MalformedKey)
    ));
}

#[test]
fn hostname_username_and_port_bounds() {
    for host in ["h".to_owned(), "h".repeat(MAX_HOSTNAME_BYTES)] {
        for user in ["a".to_owned(), "a".repeat(usize::from(u8::MAX))] {
            let mut payload = payload();
            payload.ssh_host = host.clone();
            payload.ssh_user = user;
            payload.ssh_port = u16::MAX;
            let code = encode_pairing_code(&payload).unwrap();
            assert_eq!(decode_pairing_code(&code).unwrap(), payload);
        }
    }
    for host in [
        String::new(),
        "h".repeat(MAX_HOSTNAME_BYTES + 1),
        "host name".into(),
        "h\0".into(),
        "héllo".into(),
    ] {
        let mut payload = payload();
        payload.ssh_host = host;
        assert!(encode_pairing_code(&payload).is_err());
    }
    for user in [
        String::new(),
        "a".repeat(usize::from(u8::MAX) + 1),
        "a\nb".into(),
        "a b".into(),
        "álîce".into(),
    ] {
        let mut payload = payload();
        payload.ssh_user = user;
        assert!(encode_pairing_code(&payload).is_err());
    }
    let mut payload = payload();
    payload.ssh_port = 0;
    assert!(encode_pairing_code(&payload).is_err());
}

fn raw_tailcat(fields: Vec<(&str, Value)>) -> String {
    let fields = fields
        .into_iter()
        .map(|(key, value)| (Value::Text(key.into()), value))
        .collect();
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(&Value::Map(fields), &mut bytes).unwrap();
    format!("tc{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn tailcat_fields() -> Vec<(&'static str, Value)> {
    vec![
        ("p", Value::Bytes(vec![1; 32])),
        ("k", Value::Bytes(vec![2; 32])),
        ("i", Value::Integer(1.into())),
    ]
}

// Encode untrusted input without going through the encoder's validation.
fn unvalidated_tailcat_code(address: &str) -> String {
    let mut bytes = vec![ADDRESS_TAILCAT];
    bytes.extend_from_slice(&u16::try_from(address.len()).unwrap().to_be_bytes());
    bytes.extend_from_slice(address.as_bytes());
    bytes.extend_from_slice(&22_u16.to_be_bytes());
    bytes.push(5);
    bytes.extend_from_slice(b"alice");
    bytes.extend_from_slice(&[7; ED25519_SEED_BYTES]);
    bytes.extend_from_slice(&[9; SHA256_BYTES]);
    format!("{ENVELOPE_PREFIX}{}", base45_encode(&bytes))
}

#[test]
fn validates_complete_tailcat_addresses_in_both_directions() {
    let mut invalid = vec!["tcYWJj".to_owned(), raw_tailcat(vec![])];
    for (field, value) in [
        ("p", Value::Bytes(vec![0; 32])),
        ("p", Value::Bytes(vec![1; 31])),
        ("k", Value::Null),
        ("k", Value::Bytes(vec![0; 32])),
        ("k", Value::Text("not-a-key".into())),
        ("q", Value::Bytes(vec![3; 33])),
        ("i", Value::Integer(0.into())),
        ("r", Value::Array(vec![Value::Null])),
        (
            "r",
            Value::Array(vec![Value::Map(vec![]), Value::Map(vec![])]),
        ),
        (
            "r",
            Value::Array(vec![Value::Map(vec![(
                Value::Text("N".into()),
                Value::Array(vec![Value::Null]),
            )])]),
        ),
    ] {
        let mut fields = tailcat_fields();
        fields.retain(|(key, _)| *key != field);
        fields.push((field, value));
        invalid.push(raw_tailcat(fields));
    }
    let valid = raw_tailcat(tailcat_fields());
    let mut trailing = URL_SAFE_NO_PAD
        .decode(valid.strip_prefix("tc").unwrap())
        .unwrap();
    trailing.push(0);
    invalid.push(format!("tc{}", URL_SAFE_NO_PAD.encode(trailing)));
    for address in invalid {
        let mut payload = payload();
        payload.tailcat = true;
        payload.ssh_host.clone_from(&address);
        assert!(matches!(
            encode_pairing_code(&payload),
            Err(ProtocolError::BadPayload(_))
        ));
        let error = decode_pairing_code(&unvalidated_tailcat_code(&address)).unwrap_err();
        assert!(matches!(error, ProtocolError::BadPayload(_)));
        assert!(!error.to_string().contains(&address));
    }
    let mut payload = payload();
    payload.tailcat = true;
    payload.ssh_host = valid;
    let code = encode_pairing_code(&payload).unwrap();
    assert_eq!(decode_pairing_code(&code).unwrap(), payload);
}

#[test]
fn tailcat_address_length_boundary() {
    let address = (0..MAX_TAILCAT_ADDRESS_BYTES)
        .map(|padding| {
            let mut fields = tailcat_fields();
            fields.push(("padding", Value::Bytes(vec![0; padding])));
            raw_tailcat(fields)
        })
        .find(|address| address.len() == MAX_TAILCAT_ADDRESS_BYTES)
        .unwrap();
    let mut payload = payload();
    payload.tailcat = true;
    payload.ssh_host = address;
    let code = encode_pairing_code(&payload).unwrap();
    assert_eq!(decode_pairing_code(&code).unwrap(), payload);
    payload.ssh_host.push('A');
    assert!(encode_pairing_code(&payload).is_err());
    assert!(decode_pairing_code(&unvalidated_tailcat_code(&payload.ssh_host)).is_err());
}

#[test]
fn rejects_every_truncation_trailing_data_and_oversized_codes() {
    let code = encode_pairing_code(&payload()).unwrap();
    let mut raw = base45_decode(code.strip_prefix(ENVELOPE_PREFIX).unwrap()).unwrap();
    for length in 0..raw.len() {
        let truncated = format!("{ENVELOPE_PREFIX}{}", base45_encode(&raw[..length]));
        assert!(decode_pairing_code(&truncated).is_err());
    }
    raw.push(0);
    assert!(matches!(
        decode_pairing_code(&format!("{ENVELOPE_PREFIX}{}", base45_encode(&raw))),
        Err(ProtocolError::TrailingData)
    ));
    assert!(matches!(
        decode_pairing_code(&format!(
            "{ENVELOPE_PREFIX}{}",
            "0".repeat(MAX_BASE45_BYTES + 1)
        )),
        Err(ProtocolError::BadEncoding)
    ));
    raw[0] = 255;
    assert!(matches!(
        decode_pairing_code(&format!("{ENVELOPE_PREFIX}{}", base45_encode(&raw))),
        Err(ProtocolError::BadEncoding)
    ));
}

#[test]
fn payload_debug_redacts_bearer_credentials() {
    let mut payload = payload();
    payload.tailcat = true;
    payload.ssh_host = raw_tailcat(tailcat_fields());
    let debug = format!("{payload:?}");
    assert!(!debug.contains(&payload.ssh_host));
    assert!(!debug.contains(&format!("{:?}", payload.temporary_private_key_seed)));
}

#[test]
fn enrollment_json_preserves_existing_wire_messages() {
    let request = EnrollmentRequest {
        device_name: "phone".into(),
        public_key: "ssh-ed25519 AAAA phone".into(),
    };
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        serde_json::json!({ "device_name": "phone", "public_key": "ssh-ed25519 AAAA phone" })
    );
    assert_eq!(
        serde_json::to_value(EnrollmentResponse::approved("SHA256:example", false)).unwrap(),
        serde_json::json!({ "approved": true, "fingerprint": "SHA256:example", "already_present": false })
    );
    assert_eq!(
        serde_json::to_value(EnrollmentResponse::error(
            "rejected",
            "the host user rejected enrollment"
        ))
        .unwrap(),
        serde_json::json!({ "approved": false, "code": "rejected", "message": "the host user rejected enrollment" })
    );
    let response: EnrollmentResponse = serde_json::from_str(r#"{"approved":true}"#).unwrap();
    assert!(response.approved);
    assert!(response.fingerprint.is_none());
}

proptest! {
    #[test]
    fn arbitrary_payloads_round_trip(
        address in any::<[u8; 4]>(), port in 1_u16..=u16::MAX,
        user in "[a-z]{1,255}", seed in any::<[u8; ED25519_SEED_BYTES]>(),
        host_key in any::<[u8; SHA256_BYTES]>(),
    ) {
        let payload = PairingPayload {
            ssh_host: IpAddr::from(address).to_string(), tailcat: false, ssh_port: port,
            ssh_user: user, temporary_private_key_seed: seed, ssh_host_key_sha256: host_key,
        };
        let encoded = encode_pairing_code(&payload).unwrap();
        prop_assert_eq!(decode_pairing_code(&encoded).unwrap(), payload);
    }

    #[test]
    fn arbitrary_bytes_round_trip_base45(bytes in prop::collection::vec(any::<u8>(), 0..=MAX_TAILCAT_ADDRESS_BYTES)) {
        if !bytes.is_empty() {
            prop_assert_eq!(base45_decode(&base45_encode(&bytes)).unwrap(), bytes);
        }
    }

    #[test]
    fn hostile_payloads_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..=2048)) {
        let _ = decode_pairing_code(&format!("{ENVELOPE_PREFIX}{}", base45_encode(&bytes)));
    }
}
