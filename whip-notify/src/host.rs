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

fn open_private(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.mode() & 0o077 != 0 {
        return Err("unsafe private file".into());
    }
    Ok(file)
}

fn read_private_file(file: File) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(65_537).read_to_end(&mut bytes)?;
    if bytes.len() > 65_536 {
        return Err("file too large".into());
    }
    Ok(bytes)
}

pub fn read_private(path: &Path) -> Result<Vec<u8>> {
    read_private_file(open_private(path)?)
}

pub fn lease_valid(state: &Path, device: &str, clock: impl FnOnce() -> SystemTime) -> bool {
    if !valid_id(device) {
        return false;
    }
    let path = state.join("leases").join(device);
    let Ok(file) = open_private(&path) else {
        return false;
    };
    let Ok(mtime) = file.metadata().and_then(|meta| meta.modified()) else {
        return false;
    };
    let Ok(bytes) = read_private_file(file) else {
        return false;
    };
    if bytes != LEASE_MARKER {
        return false;
    }
    // A renewal may replace the path at any time. Read one inode and only then
    // sample the clock, so a fresh lease cannot appear future-dated.
    clock()
        .duration_since(mtime)
        .ok()
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
    // Registrations written before preview support remain encrypted.
    #[serde(default = "encrypted_by_default")]
    pub end_to_end_encrypted: bool,
}
fn encrypted_by_default() -> bool {
    true
}

pub const PREVIEW_TITLE_BYTES: usize = 160;
pub const PREVIEW_BODY_BYTES: usize = 320;
const PREVIEW_LABEL_BYTES: usize = 64;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct NotificationPreview {
    pub title: String,
    pub body: String,
}

#[derive(Serialize)]
pub struct PushRequest<'a> {
    #[serde(flatten)]
    pub envelope: &'a Envelope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<&'a NotificationPreview>,
}

impl Registration {
    pub fn push_request<'a>(
        &self,
        envelope: &'a Envelope,
        preview: &'a NotificationPreview,
    ) -> PushRequest<'a> {
        PushRequest {
            envelope,
            preview: (!self.end_to_end_encrypted).then_some(preview),
        }
    }
}

fn preview_text(value: &str, max_bytes: usize) -> String {
    let mut text = String::new();
    for c in value.trim().chars().filter(|c| !c.is_control()) {
        if text.len() + c.len_utf8() > max_bytes {
            break;
        }
        text.push(c);
    }
    text
}

/// Only use pane-specific context when it belongs to the event's pane.
pub fn notification_preview(
    event: &NotificationEvent,
    json: &str,
    context: &str,
    hostname: &str,
) -> Result<NotificationPreview> {
    let hook: Hook = serde_json::from_str(json)?;
    let context: serde_json::Value = serde_json::from_str(context)?;
    let pane_context = context["focused_pane_id"].as_str() == Some(&event.pane_id);
    let name = hook
        .data
        .agent
        .as_deref()
        .or_else(|| {
            pane_context
                .then(|| context["focused_pane_agent"].as_str())
                .flatten()
        })
        .map(|name| preview_text(name, PREVIEW_LABEL_BYTES))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Agent".into());
    let action = if event.status == "blocked" {
        "needs you"
    } else {
        "finished"
    };
    let tab = pane_context
        .then(|| context["tab_label"].as_str())
        .flatten();
    let tab = tab
        .map(|tab| preview_text(tab, PREVIEW_LABEL_BYTES))
        .filter(|tab| !tab.is_empty());
    let title = match tab {
        Some(tab) => format!("{tab} · {name} {action}"),
        None => format!("{name} {action}"),
    };
    let body = event
        .title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .map(|title| preview_text(title, PREVIEW_BODY_BYTES))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| format!("Agent is {}", event.status));
    let hostname = preview_text(hostname, PREVIEW_LABEL_BYTES);
    let body = if hostname.is_empty() {
        body
    } else {
        format!("{hostname} · {body}")
    };
    Ok(NotificationPreview {
        title: preview_text(&title, PREVIEW_TITLE_BYTES),
        body: preview_text(&body, PREVIEW_BODY_BYTES),
    })
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
    agent: Option<String>,
}

pub fn parse_event(json: &str, context: &str, session: &str) -> Result<Option<NotificationEvent>> {
    if json.len() > 65_536 || context.len() > 65_536 {
        return Err("hook too large".into());
    }
    let hook: Hook = serde_json::from_str(json)?;
    let _: serde_json::Value = serde_json::from_str(context)?;
    // The manifest subscription uses dotted names, while Herdr 0.9.5 serializes
    // the event envelope with its snake_case wire name.
    if hook.event != "pane_agent_status_changed"
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
        .filter(|d| {
            d.session == event.session && !lease_valid(&store.state, &d.device_id, SystemTime::now)
        })
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
