//! Android privileged tools share the launch's existing MCP authorization.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{BrowserError, decode, invalid_result};

pub(super) const STATUS: &str = "device.shizuku_status";
pub(super) const EXEC: &str = "device.shizuku_exec";
pub(super) const NAMES: &[&str] = &[STATUS, EXEC];
const MAX_ARGS: usize = 128;
const MAX_ARG_BYTES: usize = 8192;
const MAX_ARGV_BYTES: usize = 16_384;
const MIN_TIMEOUT_MS: u32 = 100;
const MAX_TIMEOUT_MS: u32 = 15_000;
const MAX_OUTPUT_BYTES: usize = 8192;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExecArgs {
    pub argv: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u32,
    #[serde(default = "default_output_limit")]
    pub max_output_bytes: usize,
}
const fn default_timeout() -> u32 {
    10_000
}
const fn default_output_limit() -> usize {
    MAX_OUTPUT_BYTES
}

impl ExecArgs {
    pub(super) fn validate(&self) -> Result<(), BrowserError> {
        if self.argv.is_empty()
            || self.argv.len() > MAX_ARGS
            || !self.argv[0].starts_with('/')
            || self.argv[0].trim().is_empty()
            || self
                .argv
                .iter()
                .any(|arg| arg.contains('\0') || arg.len() > MAX_ARG_BYTES)
            || self.argv.iter().map(String::len).sum::<usize>() > MAX_ARGV_BYTES
        {
            return Err(BrowserError::invalid(
                "argv must contain an absolute Android executable path and at most 128 arguments, 8192 bytes each, 16384 bytes total, without NUL",
            ));
        }
        if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&self.timeout_ms)
            || !(1..=MAX_OUTPUT_BYTES).contains(&self.max_output_bytes)
        {
            return Err(BrowserError::invalid(
                "timeout_ms must be 100..15000 and max_output_bytes must be 1..8192",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Status {
    Unavailable,
    NotInstalled,
    Stopped,
    Unsupported,
    PermissionRequired,
    Denied,
    Ready,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Backend {
    Shizuku,
    Sui,
}
#[derive(Deserialize, Serialize)]
struct StatusResult {
    status: Status,
    authorized: bool,
    backend: Option<Backend>,
    uid: Option<u32>,
    server_version: Option<u32>,
}

pub(super) fn status_result(value: Value) -> Result<Value, BrowserError> {
    let result: StatusResult = decode(value)?;
    if result.authorized != (result.status == Status::Ready)
        || result.uid.is_some_and(|uid| uid != 0 && uid != 2000)
        || (result.authorized
            && (result.uid.is_none()
                || result.backend.is_none()
                || result.server_version.is_none_or(|version| version < 11)))
    {
        return Err(invalid_result());
    }
    Ok(json!(result))
}

#[derive(Deserialize, Serialize)]
struct ExecResult {
    uid: u32,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
    timed_out: bool,
}
pub(super) fn exec_result(args: &ExecArgs, value: Value) -> Result<Value, BrowserError> {
    let result: ExecResult = decode(value)?;
    if (result.uid != 0 && result.uid != 2000)
        || result.stdout.chars().count() > args.max_output_bytes
        || result.stderr.chars().count() > args.max_output_bytes
        || result.timed_out != result.exit_code.is_none()
    {
        return Err(invalid_result());
    }
    Ok(json!(result))
}

pub(super) fn tools() -> Vec<Value> {
    vec![
        json!({"name":STATUS,"description":"Check the Android phone's live Shizuku authorization and service identity. Returns status, authorized, backend, uid (2000 for ADB shell or 0 for root), and server_version. Does not prompt or start Shizuku. iOS returns unavailable. An empty Shizuku manager app list on Android 17 does not imply that authorization failed.","annotations":{"readOnlyHint":true},"inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":EXEC,"description":"Execute a command on the Android PHONE through an authorized Shizuku UserService, as ADB shell (uid 2000) or root (uid 0). Use for Android diagnostics and control, e.g. /system/bin/dumpsys, /system/bin/settings, /system/bin/pm, /system/bin/input. argv is passed literally; to use pipes or shell syntax explicitly pass [/system/bin/sh, -c, script]. This can change device state. Requires the user to pair Whip in More first; never opens permission prompts from MCP. Returns uid, exit_code, stdout, stderr, truncated and timed_out. UTF-8 text output only, bounded per stream; stdin is closed. Timeout and session cancellation stop the command group; detached background jobs are unsupported. Nonzero exit_code is a command failure; timed_out=true has exit_code=null. Shizuku's ADB identity is not root and cannot bypass Android's sandbox or SELinux. This tool is not a shell on the SSH host.","annotations":{"readOnlyHint":false,"destructiveHint":true,"idempotentHint":false},"inputSchema":{"type":"object","properties":{"argv":{"type":"array","minItems":1,"maxItems":MAX_ARGS,"items":{"type":"string","maxLength":MAX_ARG_BYTES},"description":"Absolute executable path followed by literal arguments. At most 16384 UTF-8 bytes total; NUL is rejected."},"timeout_ms":{"type":"integer","minimum":MIN_TIMEOUT_MS,"maximum":MAX_TIMEOUT_MS,"default":default_timeout()},"max_output_bytes":{"type":"integer","minimum":1,"maximum":MAX_OUTPUT_BYTES,"default":default_output_limit(),"description":"Maximum captured bytes per stdout/stderr stream. Extra output is drained and discarded."}},"required":["argv"],"additionalProperties":false}}),
    ]
}
