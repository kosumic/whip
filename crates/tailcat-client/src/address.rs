// Adapted from spullara/tailcat-rs at b24e19b9624049c269e689edeacee4e871884d81.
// Copyright (c) 2020 Tailscale Inc & contributors. SPDX-License-Identifier: BSD-3-Clause
//! Offline compact Tailcat address parsing shared by validation and transport.
use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ciborium::Value;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

const MAX_ADDRESS_BYTES: usize = 1 << 20;

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
