// Adapted from spullara/tailcat-rs at b24e19b9624049c269e689edeacee4e871884d81.
// Copyright (c) 2020 Tailscale Inc & contributors. SPDX-License-Identifier: BSD-3-Clause
//! Tailcat's stable wire vocabulary: keys, compact addresses, meow and disco.
//!
//! These encodings are intentionally independent of the networking backend.
use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ciborium::Value;
use crypto_box::{
    PublicKey, SalsaBox, SecretKey,
    aead::{Aead, AeadCore},
};
use hmac::{Hmac, Mac};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    fmt,
    net::{IpAddr, Ipv6Addr, SocketAddr},
    str::FromStr,
    time::Duration,
};

pub const DEFAULT_DERP_MAP_URL: &str = "https://tailcat.dev/derpmap.json";
pub const DISCO_MAGIC: &[u8] = b"TS\xf0\x9f\x92\xac";
const MAX_ADDRESS_BYTES: usize = 1 << 20;

/// A Curve25519 node identity. Debug output deliberately excludes secret bytes.
#[derive(Clone, PartialEq, Eq, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub struct PrivateKey(pub [u8; 32]);

impl PrivateKey {
    pub fn new() -> Self {
        let mut raw = [0; 32];
        OsRng.fill_bytes(&mut raw);
        clamp(&mut raw);
        Self(raw)
    }

    pub fn public(&self) -> [u8; 32] {
        x25519_dalek::x25519(self.0, x25519_dalek::X25519_BASEPOINT_BYTES)
    }

    pub fn disco_private(&self) -> [u8; 32] {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.0).expect("HMAC accepts any key");
        mac.update(b"github.com/tailscale/tailcat disco key v1");
        let mut raw: [u8; 32] = mac.finalize().into_bytes().into();
        clamp(&mut raw);
        raw
    }

    pub fn disco_public(&self) -> [u8; 32] {
        x25519_dalek::x25519(self.disco_private(), x25519_dalek::X25519_BASEPOINT_BYTES)
    }
}

impl Default for PrivateKey {
    fn default() -> Self {
        Self::new()
    }
}
impl fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PrivateKey([REDACTED])")
    }
}
impl fmt::Display for PrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "privkey:{}", hex::encode(self.0))
    }
}
impl FromStr for PrivateKey {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        let raw = parse_hex_key(s, "privkey:")?;
        if raw == [0; 32] {
            bail!("zero private key");
        }
        Ok(Self(raw))
    }
}
impl Serialize for PrivateKey {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
impl<'de> Deserialize<'de> for PrivateKey {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(d)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

fn clamp(raw: &mut [u8; 32]) {
    raw[0] &= 248;
    raw[31] &= 127;
    raw[31] |= 64;
}

pub fn parse_hex_key(s: &str, prefix: &str) -> Result<[u8; 32]> {
    let hex = s
        .strip_prefix(prefix)
        .ok_or_else(|| anyhow!("key must start with {prefix}"))?;
    let mut raw = [0; 32];
    hex::decode_to_slice(hex, &mut raw).context("key must contain exactly 32 hex-encoded bytes")?;
    Ok(raw)
}

fn serialize_node_key<S: Serializer>(key: &[u8; 32], s: S) -> std::result::Result<S::Ok, S::Error> {
    s.serialize_str(&format!("nodekey:{}", hex::encode(key)))
}
fn deserialize_node_key<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<[u8; 32], D::Error> {
    parse_hex_key(&String::deserialize(d)?, "nodekey:").map_err(serde::de::Error::custom)
}
fn serialize_disco_key<S: Serializer>(
    key: &Option<[u8; 32]>,
    s: S,
) -> std::result::Result<S::Ok, S::Error> {
    match key {
        Some(k) => s.serialize_str(&format!("discokey:{}", hex::encode(k))),
        None => s.serialize_none(),
    }
}
fn deserialize_disco_key<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<[u8; 32]>, D::Error> {
    Option::<String>::deserialize(d)?
        .map(|s| parse_hex_key(&s, "discokey:").map_err(serde::de::Error::custom))
        .transpose()
}
fn serialize_psk<S: Serializer>(
    key: &Option<[u8; 32]>,
    s: S,
) -> std::result::Result<S::Ok, S::Error> {
    match key {
        Some(key) => s.serialize_str(&format!("psk:{}", hex::encode(key))),
        None => s.serialize_none(),
    }
}
fn deserialize_psk<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<[u8; 32]>, D::Error> {
    Option::<String>::deserialize(d)?
        .map(|s| parse_hex_key(&s, "psk:").map_err(serde::de::Error::custom))
        .transpose()
        .map(|key| key.filter(|k| *k != [0; 32]))
}
fn is_zero(v: &i64) -> bool {
    *v == 0
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct ConnInfo {
    #[serde(
        serialize_with = "serialize_node_key",
        deserialize_with = "deserialize_node_key"
    )]
    pub server_public: [u8; 32],
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_disco_key",
        deserialize_with = "deserialize_disco_key"
    )]
    pub server_disco_public: Option<[u8; 32]>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_psk",
        deserialize_with = "deserialize_psk"
    )]
    pub preshared_key: Option<[u8; 32]>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub region: Vec<Region>,
    #[serde(rename = "RegionID", skip_serializing_if = "is_zero")]
    pub region_id: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct Region {
    #[serde(rename = "RegionID")]
    pub region_id: i64,
    pub region_code: String,
    pub region_name: String,
    pub nodes: Vec<Node>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct Node {
    pub name: String,
    #[serde(rename = "RegionID")]
    pub region_id: i64,
    pub host_name: String,
    pub cert_name: String,
    #[serde(rename = "IPv4")]
    pub ipv4: String,
    #[serde(rename = "IPv6")]
    pub ipv6: String,
    #[serde(rename = "STUNPort")]
    pub stun_port: i32,
    #[serde(rename = "DERPPort")]
    pub derp_port: i32,
    pub insecure_for_tests: bool,
    #[serde(rename = "STUNOnly")]
    pub stun_only: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct DerpMap {
    pub regions: BTreeMap<i64, Region>,
}

impl ConnInfo {
    #[cfg(test)]
    pub fn addr(&self) -> Result<String> {
        encode_addr(self)
    }
    #[cfg(test)]
    pub fn for_key(key: &PrivateKey) -> Self {
        Self {
            server_public: key.public(),
            server_disco_public: Some(key.disco_public()),
            ..Self::default()
        }
    }
    pub async fn expand(&mut self, url: Option<&str>) -> Result<()> {
        expand(self, url).await
    }
}

#[cfg(test)]
fn field(name: &str, value: Value) -> (Value, Value) {
    (Value::Text(name.into()), value)
}
#[cfg(test)]
fn push_string(fields: &mut Vec<(Value, Value)>, name: &str, text: &str) {
    if !text.is_empty() {
        fields.push(field(name, Value::Text(text.into())));
    }
}
#[cfg(test)]
fn push_int(fields: &mut Vec<(Value, Value)>, name: &str, number: i64) {
    if number != 0 {
        fields.push(field(name, Value::Integer(number.into())));
    }
}

#[cfg(test)]
pub fn encode_addr(ci: &ConnInfo) -> Result<String> {
    let mut fields = vec![field("p", Value::Bytes(ci.server_public.to_vec()))];
    if let Some(key) = ci.server_disco_public.filter(|k| *k != [0; 32]) {
        fields.push(field("k", Value::Bytes(key.to_vec())));
    }
    if let Some(key) = ci.preshared_key.filter(|k| *k != [0; 32]) {
        fields.push(field("q", Value::Bytes(key.to_vec())));
    }
    if !ci.region.is_empty() {
        let regions = ci
            .region
            .iter()
            .map(|r| {
                let nodes: Vec<Value> = r
                    .nodes
                    .iter()
                    .filter(|n| !n.stun_only)
                    .map(|n| {
                        let mut fields = Vec::new();
                        if n.host_name.is_empty() {
                            push_string(&mut fields, "n", &n.name);
                        }
                        push_string(&mut fields, "h", &n.host_name);
                        push_string(&mut fields, "t", &n.cert_name);
                        push_string(&mut fields, "4", &n.ipv4);
                        push_string(&mut fields, "6", &n.ipv6);
                        push_int(&mut fields, "s", i64::from(n.stun_port));
                        push_int(&mut fields, "d", i64::from(n.derp_port));
                        if n.insecure_for_tests {
                            fields.push(field("x", Value::Bool(true)));
                        }
                        Value::Map(fields)
                    })
                    .collect();
                Value::Map(if nodes.is_empty() {
                    vec![]
                } else {
                    vec![field("N", Value::Array(nodes))]
                })
            })
            .collect();
        fields.push(field("r", Value::Array(regions)));
    }
    push_int(&mut fields, "i", ci.region_id);
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(&Value::Map(fields), &mut bytes)?;
    Ok(format!("tc{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn decode_addr(addr: &str) -> Result<Value> {
    let rest = addr
        .strip_prefix("tc")
        .ok_or_else(|| anyhow!("tailcat address doesn't start with \"tc\""))?;
    if rest.len() > MAX_ADDRESS_BYTES * 4 / 3 + 4 {
        bail!("tailcat address is too large");
    }
    let bytes = URL_SAFE_NO_PAD.decode(rest).context("base64 decode")?;
    let mut reader = bytes.as_slice();
    let value = ciborium::de::from_reader(&mut reader).context("CBOR unmarshal")?;
    if !reader.is_empty() {
        bail!("trailing data after CBOR address");
    }
    Ok(value)
}

fn as_map(value: &Value) -> Result<&[(Value, Value)]> {
    match value {
        Value::Map(m) => Ok(m),
        _ => bail!("expected CBOR map"),
    }
}
fn lookup<'a>(fields: &'a [(Value, Value)], name: &str) -> Option<&'a Value> {
    fields.iter().rev().find_map(|(k, v)| {
        if k.as_text() == Some(name) {
            Some(v)
        } else {
            None
        }
    })
}
fn read_int(fields: &[(Value, Value)], name: &str) -> Result<i64> {
    match lookup(fields, name) {
        None | Some(Value::Null) => Ok(0),
        Some(Value::Integer(i)) => i64::try_from(*i).context("integer out of range"),
        _ => bail!("{name} must be an integer"),
    }
}
fn read_string(fields: &[(Value, Value)], name: &str) -> Result<String> {
    match lookup(fields, name) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::Text(s)) => Ok(s.clone()),
        _ => bail!("{name} must be text"),
    }
}
fn read_bool(fields: &[(Value, Value)], name: &str) -> Result<bool> {
    match lookup(fields, name) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        _ => bail!("{name} must be a boolean"),
    }
}
fn read_array<'a>(fields: &'a [(Value, Value)], name: &str) -> Result<&'a [Value]> {
    match lookup(fields, name) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(a)) => Ok(a),
        _ => bail!("{name} must be an array"),
    }
}
fn read_key(fields: &[(Value, Value)], name: &str) -> Result<Option<[u8; 32]>> {
    match lookup(fields, name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bytes(b)) => {
            Ok(Some(b.as_slice().try_into().map_err(|_| {
                anyhow!("invalid public key length {}, want 32", b.len())
            })?))
        }
        _ => bail!("{name} must be a 32-byte CBOR byte string"),
    }
}

pub fn parse_addr(addr: &str) -> Result<ConnInfo> {
    let value = decode_addr(addr)?;
    let fields = as_map(&value)?;
    let mut ci = ConnInfo {
        server_public: read_key(fields, "p")?.unwrap_or_default(),
        server_disco_public: read_key(fields, "k")?,
        preshared_key: read_key(fields, "q")?.filter(|k| *k != [0; 32]),
        region_id: read_int(fields, "i")?,
        region: Vec::new(),
    };
    for (ri, value) in read_array(fields, "r")?.iter().enumerate() {
        if matches!(value, Value::Null) {
            bail!("invalid tailcat address: region {ri} is null");
        }
        let fields = as_map(value)?;
        let id = read_int(fields, "i")?;
        let mut r = Region {
            region_id: if id == 0 { ri as i64 + 1 } else { id },
            region_code: read_string(fields, "c")?,
            region_name: read_string(fields, "m")?,
            nodes: Vec::new(),
        };
        if r.region_code.is_empty() {
            r.region_code = r.region_id.to_string();
        }
        for (ni, value) in read_array(fields, "N")?.iter().enumerate() {
            if matches!(value, Value::Null) {
                bail!("invalid tailcat address: region {ri} node {ni} is null");
            }
            let fields = as_map(value)?;
            let mut n = Node {
                name: read_string(fields, "n")?,
                region_id: read_int(fields, "i")?,
                host_name: read_string(fields, "h")?,
                cert_name: read_string(fields, "t")?,
                ipv4: read_string(fields, "4")?,
                ipv6: read_string(fields, "6")?,
                stun_port: read_int(fields, "s")?
                    .try_into()
                    .context("invalid STUN port")?,
                derp_port: read_int(fields, "d")?
                    .try_into()
                    .context("invalid DERP port")?,
                insecure_for_tests: read_bool(fields, "x")?,
                stun_only: false,
            };
            if n.region_id == 0 {
                n.region_id = r.region_id;
            }
            if n.name.is_empty() {
                n.name.clone_from(&n.host_name);
            }
            r.nodes.push(n);
        }
        ci.region.push(r);
    }
    Ok(ci)
}

pub fn tc_addr_for_key(key: &[u8; 32]) -> Ipv6Addr {
    let mut raw = [
        0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
    raw[6..].copy_from_slice(&key[..10]);
    Ipv6Addr::from(raw)
}

pub fn nat64_addr(addr: IpAddr) -> Ipv6Addr {
    match addr {
        IpAddr::V6(a) => a,
        IpAddr::V4(a) => {
            let mut raw = [0; 16];
            raw[..4].copy_from_slice(&[0, 0x64, 0xff, 0x9b]);
            raw[12..].copy_from_slice(&a.octets());
            Ipv6Addr::from(raw)
        }
    }
}

pub fn encode_meow_ping(node: &[u8; 32], disco: &[u8; 32]) -> Vec<u8> {
    let mut b = b"meow\x01".to_vec();
    b.extend_from_slice(node);
    b.extend_from_slice(disco);
    b
}

pub fn is_meowed_packet(b: &[u8]) -> bool {
    b.starts_with(b"meow\x02")
}

/// NaCl's Curve25519/XSalsa20/Poly1305 box, including the 24-byte nonce.
pub fn seal_box(private: &[u8; 32], public: &[u8; 32], payload: &[u8]) -> Result<Vec<u8>> {
    if *private == [0; 32] || *public == [0; 32] {
        bail!("cannot seal with zero key");
    }
    let cipher = SalsaBox::new(&PublicKey::from(*public), &SecretKey::from(*private));
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    let mut out = nonce.to_vec();
    out.extend(
        cipher
            .encrypt(&nonce, payload)
            .map_err(|_| anyhow!("NaCl box encryption failed"))?,
    );
    Ok(out)
}

pub fn open_box(private: &[u8; 32], public: &[u8; 32], payload: &[u8]) -> Result<Vec<u8>> {
    if *private == [0; 32] || *public == [0; 32] || payload.len() < 40 {
        bail!("invalid NaCl box");
    }
    let cipher = SalsaBox::new(&PublicKey::from(*public), &SecretKey::from(*private));
    cipher
        .decrypt(payload[..24].into(), &payload[24..])
        .map_err(|_| anyhow!("NaCl box authentication failed"))
}

pub fn seal_disco(key: &PrivateKey, peer_disco: &[u8; 32], payload: &[u8]) -> Result<Vec<u8>> {
    let mut b = DISCO_MAGIC.to_vec();
    b.extend_from_slice(&key.disco_public());
    b.extend(seal_box(&key.disco_private(), peer_disco, payload)?);
    Ok(b)
}

pub fn open_disco(key: &PrivateKey, packet: &[u8]) -> Result<([u8; 32], Vec<u8>)> {
    if packet.len() < 78 || !packet.starts_with(DISCO_MAGIC) {
        bail!("invalid disco wrapper");
    }
    let public = packet[6..38].try_into()?;
    Ok((
        public,
        open_box(&key.disco_private(), &public, &packet[38..])?,
    ))
}

pub fn encode_call_me_maybe(endpoints: &[SocketAddr]) -> Vec<u8> {
    let mut b = vec![3, 0];
    for endpoint in endpoints {
        b.extend_from_slice(
            &match endpoint.ip() {
                IpAddr::V4(a) => a.to_ipv6_mapped(),
                IpAddr::V6(a) => a,
            }
            .octets(),
        );
        b.extend_from_slice(&endpoint.port().to_be_bytes());
    }
    b
}

pub fn parse_call_me_maybe(payload: &[u8]) -> Vec<SocketAddr> {
    if payload.len() < 2 || payload[..2] != [3, 0] || !(payload.len() - 2).is_multiple_of(18) {
        return vec![];
    }
    payload[2..]
        .as_chunks::<18>()
        .0
        .iter()
        .map(|p| {
            let a = Ipv6Addr::from(<[u8; 16]>::try_from(&p[..16]).expect("chunk size"));
            SocketAddr::new(
                a.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(a)),
                u16::from_be_bytes([p[16], p[17]]),
            )
        })
        .collect()
}

/// Resolve compact region IDs without persisting addresses or keys to disk.
pub async fn expand(ci: &mut ConnInfo, url: Option<&str>) -> Result<()> {
    if !ci.region.is_empty() {
        return Ok(());
    }
    if ci.region_id <= 0 {
        bail!("address has no DERP region");
    }
    let mut response = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?
        .get(url.unwrap_or(DEFAULT_DERP_MAP_URL))
        .header("Tailcat-Mode", "client")
        .send()
        .await?
        .error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 8 << 20 {
            bail!("DERP map exceeds 8 MiB");
        }
        bytes.extend_from_slice(&chunk);
    }
    let mut map: DerpMap = serde_json::from_slice(&bytes).context("invalid DERP map")?;
    ci.region.push(
        map.regions
            .remove(&ci.region_id)
            .context("unknown DERP region")?,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preshared_key_roundtrips_and_rejects_bad_lengths() {
        let ci = ConnInfo {
            preshared_key: Some([42; 32]),
            ..ConnInfo::for_key(&PrivateKey::new())
        };
        assert!(parse_addr(&ci.addr().unwrap()).unwrap() == ci);
        let json = serde_json::to_string(&ci).unwrap();
        assert!(json.contains("psk:2a2a"));
        assert!(serde_json::from_str::<ConnInfo>(&json).unwrap() == ci);
        assert!(serde_json::from_str::<ConnInfo>(r#"{"PresharedKey":"psk:00"}"#).is_err());
        let mut bytes = Vec::new();
        ciborium::ser::into_writer(
            &Value::Map(vec![field("q", Value::Bytes(vec![1; 31]))]),
            &mut bytes,
        )
        .unwrap();
        assert!(parse_addr(&format!("tc{}", URL_SAFE_NO_PAD.encode(bytes))).is_err());
    }

    #[test]
    fn go_address_vectors() {
        let mut key = [0; 32];
        key[1] = 1;
        key[2] = 2;
        key[31] = 31;
        for (region_id, addr) in [
            (0, "tcoWFwWCAAAQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHw"),
            (
                10,
                "tcomFwWCAAAQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH2FpCg",
            ),
        ] {
            let ci = ConnInfo {
                server_public: key,
                region_id,
                ..Default::default()
            };
            assert_eq!(encode_addr(&ci).unwrap(), addr);
            assert!(parse_addr(addr).unwrap() == ci);
        }
    }

    #[test]
    fn embeds_only_required_fields() {
        let key = PrivateKey([7; 32]);
        let mut ci = ConnInfo::for_key(&key);
        ci.region.push(Region {
            region_id: 123,
            region_code: "sea".into(),
            region_name: "Seattle".into(),
            nodes: vec![
                Node {
                    name: "10a".into(),
                    region_id: 123,
                    host_name: "relay.test".into(),
                    cert_name: "cert.test".into(),
                    ipv6: "none".into(),
                    stun_port: -1,
                    derp_port: 8443,
                    insecure_for_tests: true,
                    ..Default::default()
                },
                Node {
                    stun_only: true,
                    ..Default::default()
                },
            ],
        });
        let encoded = encode_addr(&ci).unwrap();
        let got = parse_addr(&encoded).unwrap();
        assert_eq!(got.region[0].region_id, 1);
        assert_eq!(got.region[0].region_code, "1");
        assert_eq!(got.region[0].nodes.len(), 1);
        assert_eq!(got.region[0].nodes[0].name, "relay.test");
        assert_eq!(got.region[0].nodes[0].cert_name, "cert.test");
        assert_eq!(encode_addr(&got).unwrap(), encoded);
    }

    fn raw_addr(v: Value) -> String {
        let mut raw = vec![];
        ciborium::ser::into_writer(&v, &mut raw).unwrap();
        format!("tc{}", URL_SAFE_NO_PAD.encode(raw))
    }

    #[test]
    fn malformed_addresses_are_errors() {
        for n in [0, 31, 33] {
            let addr = raw_addr(Value::Map(vec![field("p", Value::Bytes(vec![0; n]))]));
            assert!(parse_addr(&addr).is_err());
        }
        for value in [
            Value::Null,
            Value::Map(vec![field("N", Value::Array(vec![Value::Null]))]),
        ] {
            let addr = raw_addr(Value::Map(vec![field("r", Value::Array(vec![value]))]));
            assert!(parse_addr(&addr).is_err());
        }
    }

    #[test]
    fn keys_and_disco_authenticate() {
        let a = PrivateKey([7; 32]);
        let b = PrivateKey([8; 32]);
        assert_ne!(a.public(), a.disco_public());
        assert_eq!(a.disco_public(), a.clone().disco_public());
        assert_eq!(a.to_string().parse::<PrivateKey>().unwrap(), a);
        let packet = seal_disco(&a, &b.disco_public(), b"test").unwrap();
        assert_eq!(
            open_disco(&b, &packet).unwrap(),
            (a.disco_public(), b"test".to_vec())
        );
        let mut corrupted = packet;
        *corrupted.last_mut().unwrap() ^= 1;
        assert!(open_disco(&b, &corrupted).is_err());
    }

    #[test]
    fn endpoint_and_nat64_roundtrips() {
        let endpoints = [
            "192.0.2.1:1234".parse().unwrap(),
            "[2001:db8::1]:2345".parse().unwrap(),
        ];
        assert_eq!(
            parse_call_me_maybe(&encode_call_me_maybe(&endpoints)),
            endpoints
        );
        let ip: IpAddr = "192.0.2.1".parse().unwrap();
        assert_eq!(nat64_addr(ip).to_string(), "64:ff9b::c000:201");
        assert_eq!(tc_addr_for_key(&[0; 32]).to_string(), "fd7a:115c:a1e0::");
    }

    #[test]
    fn json_uses_go_key_and_field_names() {
        let ci = ConnInfo::for_key(&PrivateKey([7; 32]));
        let json = serde_json::to_value(&ci).unwrap();
        assert!(
            json["ServerPublic"]
                .as_str()
                .unwrap()
                .starts_with("nodekey:")
        );
        assert!(
            json["ServerDiscoPublic"]
                .as_str()
                .unwrap()
                .starts_with("discokey:")
        );
        assert!(serde_json::from_value::<ConnInfo>(json).unwrap() == ci);
        let dm: DerpMap = serde_json::from_str(r#"{"Regions":{"1":{"RegionID":1,"Nodes":[{"HostName":"localhost","IPv4":"127.0.0.1","DERPPort":443}]}}}"#).unwrap();
        assert_eq!(dm.regions[&1].nodes[0].ipv4, "127.0.0.1");
    }
}
