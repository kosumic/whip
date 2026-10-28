//! Short-lived plugin hooks and atomic private files. No host daemon.
use crate::{
    Envelope, Header, KeyPair, NotificationEvent, Result, VERSION, encrypt, generate_key, key_id,
    public_key, valid_id,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

pub const LEASE_TTL: Duration = Duration::from_secs(10);
pub const MAX_DEVICES: usize = 32;
const LEASE_MARKER: &[u8] = b"whip-notify-lease-v1\n";

pub fn private_dir(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("unsafe directory".into());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("missing parent")?;
    private_dir(parent)?;
    let tmp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(tmp);
    result
}

pub fn read_private(path: &Path) -> Result<Vec<u8>> {
    let before = fs::symlink_metadata(path)?;
    if !before.is_file() || before.mode() & 0o077 != 0 {
        return Err("unsafe private file".into());
    }
    let file = File::open(path)?;
    let after = file.metadata()?;
    if before.ino() != after.ino() || before.dev() != after.dev() {
        return Err("file changed".into());
    }
    let mut bytes = Vec::new();
    file.take(65_537).read_to_end(&mut bytes)?;
    if bytes.len() > 65_536 {
        return Err("file too large".into());
    }
    Ok(bytes)
}

pub fn lease_valid(state: &Path, device: &str, now: SystemTime) -> bool {
    if !valid_id(device) {
        return false;
    }
    let path = state.join("leases").join(device);
    let Ok(bytes) = read_private(&path) else {
        return false;
    };
    if bytes != LEASE_MARKER {
        return false;
    }
    fs::symlink_metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|mtime| now.duration_since(mtime).ok())
        .is_some_and(|age| age < LEASE_TTL)
}

pub fn renew_lease(state: &Path, device: &str) -> Result<()> {
    if !valid_id(device) {
        return Err("invalid device ID".into());
    }
    private_dir(state)?;
    atomic_write(&state.join("leases").join(device), LEASE_MARKER)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub device_id: String,
    pub public_key: String,
    pub relay_url: String,
    pub route_token: String,
    pub session: String,
}
impl Registration {
    pub fn validate(&self) -> Result<()> {
        if !valid_id(&self.device_id)
            || !valid_id(&self.route_token)
            || self.session.is_empty()
            || self.session.len() > 4096
        {
            return Err("invalid registration".into());
        }
        public_key(&self.public_key)?;
        let url: ureq::http::Uri = self.relay_url.parse()?;
        if url.scheme_str() != Some("https")
            || url.authority().is_none()
            || self.relay_url.ends_with('/')
        {
            return Err("relay requires an HTTPS origin without trailing slash".into());
        }
        Ok(())
    }
}

pub struct Store {
    pub config: PathBuf,
    pub state: PathBuf,
}
impl Store {
    pub fn lock(&self) -> Result<File> {
        private_dir(&self.config)?;
        let path = self.config.join(".lock");
        if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
            return Err("unsafe lock".into());
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        let start = std::time::Instant::now();
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(file),
                Err(_) if start.elapsed() < Duration::from_millis(200) => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
    pub fn identity(&self) -> Result<KeyPair> {
        let _lock = self.lock()?;
        let path = self.config.join("identity.json");
        if path.exists() {
            return Ok(serde_json::from_slice(&read_private(&path)?)?);
        }
        let key = generate_key()?;
        atomic_write(&path, &serde_json::to_vec(&key)?)?;
        Ok(key)
    }
    pub fn registrations(&self) -> Result<Vec<Registration>> {
        let path = self.config.join("devices.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let list: Vec<Registration> = serde_json::from_slice(&read_private(&path)?)?;
        if list.len() > MAX_DEVICES {
            return Err("too many devices".into());
        }
        for item in &list {
            item.validate()?;
        }
        Ok(list)
    }
    pub fn register(&self, registration: Registration) -> Result<()> {
        registration.validate()?;
        let _lock = self.lock()?;
        let mut devices = self.registrations()?;
        devices.retain(|d| d.device_id != registration.device_id);
        if devices.len() >= MAX_DEVICES {
            return Err("device limit reached".into());
        }
        devices.push(registration);
        atomic_write(
            &self.config.join("devices.json"),
            &serde_json::to_vec(&devices)?,
        )
    }
    pub fn unregister(&self, device: &str) -> Result<()> {
        if !valid_id(device) {
            return Err("invalid device ID".into());
        }
        let _lock = self.lock()?;
        let mut devices = self.registrations()?;
        devices.retain(|d| d.device_id != device);
        atomic_write(
            &self.config.join("devices.json"),
            &serde_json::to_vec(&devices)?,
        )?;
        match fs::remove_file(self.state.join("leases").join(device)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct Hook {
    event: String,
    data: HookData,
}
#[derive(Deserialize)]
struct HookData {
    pane_id: String,
    workspace_id: String,
    agent_status: String,
    title: Option<String>,
}

pub fn parse_event(json: &str, context: &str, session: &str) -> Result<Option<NotificationEvent>> {
    if json.len() > 65_536 || context.len() > 65_536 {
        return Err("hook too large".into());
    }
    let hook: Hook = serde_json::from_str(json)?;
    let _: serde_json::Value = serde_json::from_str(context)?;
    if hook.event != "pane.agent_status_changed"
        || !matches!(hook.data.agent_status.as_str(), "blocked" | "done")
    {
        return Ok(None);
    }
    if hook.data.pane_id.is_empty()
        || hook.data.pane_id.len() > 128
        || hook.data.workspace_id.len() > 128
        || session.len() > 512
    {
        return Err("invalid event context".into());
    }
    Ok(Some(NotificationEvent {
        pane_id: hook.data.pane_id,
        workspace_id: hook.data.workspace_id,
        session: session.to_owned(),
        status: hook.data.agent_status,
        title: hook.data.title.map(|s| s.chars().take(80).collect()),
    }))
}

/// Encrypt before networking; four parallel requests, one 4-second total budget.
pub fn deliver(
    store: &Store,
    event: &NotificationEvent,
    send: &(impl Fn(&Registration, &Envelope) -> Result<()> + Sync),
) -> Result<usize> {
    let host = store.identity()?;
    let devices = store.registrations()?;
    let now = SystemTime::now();
    let timestamp = now.duration_since(SystemTime::UNIX_EPOCH)?.as_secs();
    let event_id = uuid::Uuid::new_v4().to_string();
    let pending = devices
        .into_iter()
        .filter(|d| d.session == event.session && !lease_valid(&store.state, &d.device_id, now))
        .map(|d| {
            let header = Header {
                version: VERSION,
                host_id: key_id(&host.public_key),
                device_id: d.device_id.clone(),
                key_id: key_id(&d.public_key),
                event_id: event_id.clone(),
                issued_at: timestamp,
            };
            encrypt(&host, &d.public_key, header, event).map(|e| (d, e))
        })
        .collect::<Result<Vec<_>>>()?;
    let count = pending.len();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let failed = std::sync::atomic::AtomicBool::new(false);
    std::thread::scope(|scope| {
        for _ in 0..count.min(4) {
            let pending = &pending;
            let next = &next;
            let failed = &failed;
            scope.spawn(move || {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some((device, envelope)) = pending.get(i) else {
                        break;
                    };
                    if send(device, envelope).is_err() {
                        failed.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            });
        }
    });
    if failed.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("one or more push deliveries failed".into());
    }
    Ok(count)
}
