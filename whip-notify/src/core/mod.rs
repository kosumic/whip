//! Push-only Core client. No provider hooks, terminal input or Core lifecycle changes.
pub mod service;
pub mod watcher;

use crate::{Result, host::Store};
use herdr_protocol::hc::events::MAX_EVENT_LINE_BYTES;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    time::Duration,
};

pub struct Core {
    pub socket: String,
    pub key: String,
    pub store: Store,
}

pub fn home() -> Result<PathBuf> {
    Ok(PathBuf::from(
        std::env::var_os("HOME").ok_or("HOME is unavailable")?,
    ))
}
pub fn xdg(name: &str, fallback: &str) -> Result<PathBuf> {
    match std::env::var_os(name).filter(|value| !value.is_empty()) {
        Some(value) if PathBuf::from(&value).is_absolute() => Ok(value.into()),
        _ => Ok(home()?.join(fallback)),
    }
}

impl Core {
    pub fn new(socket: String) -> Result<Self> {
        if !socket.starts_with('/') || socket.len() > 4096 || socket.chars().any(char::is_control) {
            return Err("invalid Core socket".into());
        }
        let key = format!("{:x}", Sha256::digest(socket.as_bytes()))[..24].to_owned();
        Ok(Self {
            socket,
            store: Store {
                config: xdg("XDG_CONFIG_HOME", ".config")?
                    .join("whip-notify/core")
                    .join(&key),
                state: xdg("XDG_STATE_HOME", ".local/state")?
                    .join("whip-notify/core")
                    .join(&key),
            },
            key,
        })
    }
    fn connect(&self) -> Result<UnixStream> {
        // Connect only: never autostart or stop the user's Core.
        let stream = UnixStream::connect(&self.socket)?;
        stream.set_read_timeout(Some(Duration::from_secs(45)))?;
        stream.set_write_timeout(Some(Duration::from_secs(3)))?;
        Ok(stream)
    }
    pub fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        let stream = self.connect()?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        let mut stream = BufReader::new(stream);
        request(stream.get_mut(), method, params)?;
        response(&mut stream)
    }
    pub fn paths(&self) -> Result<Value> {
        Ok(json!({"config":self.store.config,"state":self.store.state,
            "binary":std::env::current_exe()?,"protocol":1,"notification_previews":true}))
    }
}

pub fn request(stream: &mut UnixStream, method: &str, params: Value) -> Result<()> {
    writeln!(
        stream,
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})
    )?;
    Ok(())
}
pub fn line(reader: &mut impl BufRead) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(MAX_EVENT_LINE_BYTES as u64 + 1)
        .read_until(b'\n', &mut bytes)?;
    if bytes.len() > MAX_EVENT_LINE_BYTES || bytes.last() != Some(&b'\n') {
        return Err("Core stream ended or exceeded its message limit".into());
    }
    Ok(bytes)
}
pub fn response(reader: &mut impl BufRead) -> Result<Value> {
    let reply: Value = serde_json::from_slice(&line(reader)?)?;
    if reply["jsonrpc"] != "2.0" || reply["id"] != 1 || reply.get("error").is_some() {
        return Err("Core request failed".into());
    }
    reply
        .get("result")
        .cloned()
        .ok_or_else(|| "Core response has no result".into())
}

pub fn run(mut args: impl Iterator<Item = String>) -> Result<()> {
    let socket = match args.next().as_deref() {
        Some("--socket") => args.next().ok_or("missing Core socket")?,
        _ => return Err("expected core --socket PATH ACTION".into()),
    };
    let core = Core::new(socket)?;
    let action = args.next().ok_or("missing Core action")?;
    let value = match action.as_str() {
        "status" => service::status(&core)?,
        "install" => {
            service::install(&core)?;
            service::status(&core)?
        }
        "enable" | "disable" => {
            service::enable(&core, action == "enable")?;
            service::status(&core)?
        }
        "uninstall" => {
            service::uninstall(&core)?;
            service::status(&core)?
        }
        "paths" => core.paths()?,
        "watch" => return watcher::watch(&core),
        _ => return Err("unknown Core push action".into()),
    };
    println!("{value}");
    Ok(())
}
