//! Generated from schema/hc.openrpc.json. See UPSTREAM.md for source and license.
//! Regenerate with: node scripts/generate-hc.cjs

use super::Error;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AttachResult {
    pub channel: u32,
    pub terminal: Terminal,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

pub type Children = String;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CoreInfo {
    pub id: String,
    pub name: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Display {
    #[serde(default)]
    pub bg: Option<String>,
    #[serde(default)]
    pub cell: Option<[u32; 2]>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub fg: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DocGetResult {
    pub value: Value,
    pub version: u64,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DocSetResult {
    pub version: u64,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Edit {
    pub new: String,
    pub old: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExecResult {
    #[serde(default)]
    pub code: Option<i32>,
    pub ms: u64,
    #[serde(default)]
    pub signal: Option<i32>,
    pub stderr: String,
    pub stdout: String,
    pub timed_out: bool,
    pub truncated: bool,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileReadResult {
    pub first: u64,
    pub last: u64,
    pub lines: u64,
    pub text: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileResult {
    pub bytes: u64,
    pub path: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FirstMessage {
    #[serde(default)]
    pub reason: Option<String>,
    pub sent: bool,
    #[serde(default)]
    pub started: Option<bool>,
    #[serde(default)]
    pub turn: Option<u64>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Foreground {
    pub argv: Vec<String>,
    pub cwd: String,
    pub name: String,
    pub pid: i32,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HelloResult {
    pub core: CoreInfo,
    pub features: Vec<String>,
    pub framed: bool,
    pub generation: u32,
    pub methods: Vec<String>,
    pub version: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HolderInfo {
    pub current: bool,
    pub instance: String,
    pub pid: u32,
    pub terminals: u64,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

pub type IdleOrWorking = String;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InterruptResult {
    pub key: String,
    pub outcome: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeysResult {
    #[serde(default)]
    pub status: Option<String>,
    pub turn: u64,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ListResult {
    pub hidden_finished: u64,
    #[serde(default)]
    pub machines: Vec<MachineView>,
    pub terminals: Vec<Terminal>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Machine {
    pub host: String,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub session: Option<String>,
    pub target: String,
    #[serde(default)]
    pub temporary: Option<bool>,
    pub version: String,
    #[serde(default)]
    pub via: Option<bool>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MachineListResult {
    pub machines: Vec<MachineView>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MachineView {
    pub host: String,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub since_ms: Option<u64>,
    pub state: String,
    pub target: String,
    #[serde(default)]
    pub temporary: Option<bool>,
    pub version: String,
    #[serde(default)]
    pub via: Option<bool>,
    #[serde(default)]
    pub why: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PutResult {
    pub bytes: u64,
    pub path: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReadResult {
    pub complete: bool,
    pub how: String,
    pub text: String,
    #[serde(default)]
    pub why: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RemoveResult {
    pub removed: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunResult {
    pub address: String,
    pub argv: Vec<String>,
    pub cols: u16,
    pub created_ms: u64,
    pub cwd: String,
    #[serde(default)]
    pub die_with_parent: Option<bool>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub finished_ms: Option<u64>,
    #[serde(default)]
    pub first_message: Option<FirstMessage>,
    #[serde(default)]
    pub foreground: Option<Foreground>,
    #[serde(default)]
    pub identity: Option<String>,
    #[serde(default)]
    pub keep: Option<bool>,
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub notify: Option<bool>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub paste_gap_ms: Option<u64>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub records: Option<BTreeMap<String, Status>>,
    #[serde(default)]
    pub reported: Option<bool>,
    #[serde(default)]
    pub rm: Option<bool>,
    pub rows: u16,
    pub screen: String,
    #[serde(default)]
    pub signal: Option<i32>,
    pub state: String,
    #[serde(default)]
    pub status: Option<Status>,
    #[serde(default)]
    pub status_ms: Option<u64>,
    #[serde(default)]
    pub stop: Option<String>,
    #[serde(default)]
    pub submit: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub turn: Option<u64>,
    #[serde(default)]
    pub wait: Option<WaitResult>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SendResult {
    #[serde(default)]
    pub started: Option<bool>,
    #[serde(default)]
    pub status: Option<String>,
    pub turn: u64,
    #[serde(default)]
    pub wait: Option<WaitResult>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Status {
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub msg: Option<String>,
    #[serde(default)]
    pub progress: Option<u8>,
    pub state: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatusResult {
    pub core: CoreInfo,
    pub finished: u64,
    #[serde(default)]
    pub holder: Option<HolderInfo>,
    pub holders: Vec<HolderInfo>,
    #[serde(default)]
    pub installed_by: Option<String>,
    pub live: u64,
    pub pid: u32,
    pub uptime_ms: u64,
    pub version: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StopResult {
    pub stopped: bool,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SubscribeResult {
    #[serde(default)]
    pub channel: Option<u32>,
    pub seq: u64,
    pub terminals: Vec<Terminal>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TemplateInfo {
    pub command: String,
    pub description: String,
    #[serde(default)]
    pub error: Option<String>,
    pub name: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TemplatesResult {
    pub templates: Vec<TemplateInfo>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Terminal {
    pub address: String,
    pub argv: Vec<String>,
    pub cols: u16,
    pub created_ms: u64,
    pub cwd: String,
    #[serde(default)]
    pub die_with_parent: Option<bool>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub finished_ms: Option<u64>,
    #[serde(default)]
    pub foreground: Option<Foreground>,
    #[serde(default)]
    pub identity: Option<String>,
    #[serde(default)]
    pub keep: Option<bool>,
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub notify: Option<bool>,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub paste_gap_ms: Option<u64>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub records: Option<BTreeMap<String, Status>>,
    #[serde(default)]
    pub reported: Option<bool>,
    #[serde(default)]
    pub rm: Option<bool>,
    pub rows: u16,
    pub screen: String,
    #[serde(default)]
    pub signal: Option<i32>,
    pub state: String,
    #[serde(default)]
    pub status: Option<Status>,
    #[serde(default)]
    pub status_ms: Option<u64>,
    #[serde(default)]
    pub stop: Option<String>,
    #[serde(default)]
    pub submit: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub turn: Option<u64>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WaitResult {
    pub children: Vec<WaitResult>,
    pub ended: bool,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub from: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub signal: Option<i32>,
    #[serde(default)]
    pub status: Option<String>,
    pub terminal: String,
    pub turn: u64,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct HelloParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calls_you: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core: Option<CoreInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ServerStatusParams {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ServerStopParams {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ServerRestartParams {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalRunParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub die_with_parent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_notify: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_parent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outlive_parent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rm: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TemplatesListParams {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalGetParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    pub terminal: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalKillParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    pub terminal: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalRmParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    pub terminal: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalKeepParams {
    pub keep: bool,
    pub terminal: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalLabelParams {
    pub labels: BTreeMap<String, String>,
    pub terminal: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u64>,
    pub terminal: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalAttachParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    pub cols: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<Display>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observe: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumed: Option<bool>,
    pub rows: u16,
    pub terminal: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalSendParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#if: Option<IdleOrWorking>,
    pub terminal: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalWaitParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Children>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalKeysParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    pub keys: Vec<String>,
    pub terminal: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalInterruptParams {
    pub terminal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TerminalPutParams {
    pub data: String,
    pub name: String,
    pub terminal: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct MachineExecParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct FileReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct FileWriteParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct FileEditParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub edits: Vec<Edit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct DocGetParams {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct DocSetParams {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    pub value: Value,
    pub version: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct EventsSubscribeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct MachineAddParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temporary: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct MachineListParams {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct MachineConnectParams {
    pub machine: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct MachineRenameParams {
    pub machine: String,
    pub new_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct MachineRmParams {
    pub machine: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct RpcDiscoverParams {}

pub type RpcDiscoverResult = Value;

#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    Hello(Box<HelloParams>),
    ServerStatus(Box<ServerStatusParams>),
    ServerStop(Box<ServerStopParams>),
    ServerRestart(Box<ServerRestartParams>),
    TerminalRun(Box<TerminalRunParams>),
    TemplatesList(Box<TemplatesListParams>),
    TerminalList(Box<TerminalListParams>),
    TerminalGet(Box<TerminalGetParams>),
    TerminalKill(Box<TerminalKillParams>),
    TerminalRm(Box<TerminalRmParams>),
    TerminalKeep(Box<TerminalKeepParams>),
    TerminalLabel(Box<TerminalLabelParams>),
    TerminalRead(Box<TerminalReadParams>),
    TerminalAttach(Box<TerminalAttachParams>),
    TerminalSend(Box<TerminalSendParams>),
    TerminalWait(Box<TerminalWaitParams>),
    TerminalKeys(Box<TerminalKeysParams>),
    TerminalInterrupt(Box<TerminalInterruptParams>),
    TerminalPut(Box<TerminalPutParams>),
    MachineExec(Box<MachineExecParams>),
    FileRead(Box<FileReadParams>),
    FileWrite(Box<FileWriteParams>),
    FileEdit(Box<FileEditParams>),
    DocGet(Box<DocGetParams>),
    DocSet(Box<DocSetParams>),
    EventsSubscribe(Box<EventsSubscribeParams>),
    MachineAdd(Box<MachineAddParams>),
    MachineList(Box<MachineListParams>),
    MachineConnect(Box<MachineConnectParams>),
    MachineRename(Box<MachineRenameParams>),
    MachineRm(Box<MachineRmParams>),
    RpcDiscover(Box<RpcDiscoverParams>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Response {
    Hello(Box<HelloResult>),
    ServerStatus(Box<StatusResult>),
    ServerStop(Box<StopResult>),
    ServerRestart(Box<StopResult>),
    TerminalRun(Box<RunResult>),
    TemplatesList(Box<TemplatesResult>),
    TerminalList(Box<ListResult>),
    TerminalGet(Box<Terminal>),
    TerminalKill(Box<Terminal>),
    TerminalRm(Box<RemoveResult>),
    TerminalKeep(Box<Terminal>),
    TerminalLabel(Box<Terminal>),
    TerminalRead(Box<ReadResult>),
    TerminalAttach(Box<AttachResult>),
    TerminalSend(Box<SendResult>),
    TerminalWait(Box<WaitResult>),
    TerminalKeys(Box<KeysResult>),
    TerminalInterrupt(Box<InterruptResult>),
    TerminalPut(Box<PutResult>),
    MachineExec(Box<ExecResult>),
    FileRead(Box<FileReadResult>),
    FileWrite(Box<FileResult>),
    FileEdit(Box<FileResult>),
    DocGet(Box<DocGetResult>),
    DocSet(Box<DocSetResult>),
    EventsSubscribe(Box<SubscribeResult>),
    MachineAdd(Box<Machine>),
    MachineList(Box<MachineListResult>),
    MachineConnect(Box<MachineView>),
    MachineRename(Box<Machine>),
    MachineRm(Box<RemoveResult>),
    RpcDiscover(Box<RpcDiscoverResult>),
}

impl Request {
    pub fn from_method_params(method: &str, value: Value) -> Result<Self, Error> {
        Ok(match method {
            "hello" => Self::Hello(Box::new(serde_json::from_value(value)?)),
            "server.status" => Self::ServerStatus(Box::new(serde_json::from_value(value)?)),
            "server.stop" => Self::ServerStop(Box::new(serde_json::from_value(value)?)),
            "server.restart" => Self::ServerRestart(Box::new(serde_json::from_value(value)?)),
            "terminal.run" => Self::TerminalRun(Box::new(serde_json::from_value(value)?)),
            "templates.list" => Self::TemplatesList(Box::new(serde_json::from_value(value)?)),
            "terminal.list" => Self::TerminalList(Box::new(serde_json::from_value(value)?)),
            "terminal.get" => Self::TerminalGet(Box::new(serde_json::from_value(value)?)),
            "terminal.kill" => Self::TerminalKill(Box::new(serde_json::from_value(value)?)),
            "terminal.rm" => Self::TerminalRm(Box::new(serde_json::from_value(value)?)),
            "terminal.keep" => Self::TerminalKeep(Box::new(serde_json::from_value(value)?)),
            "terminal.label" => Self::TerminalLabel(Box::new(serde_json::from_value(value)?)),
            "terminal.read" => Self::TerminalRead(Box::new(serde_json::from_value(value)?)),
            "terminal.attach" => Self::TerminalAttach(Box::new(serde_json::from_value(value)?)),
            "terminal.send" => Self::TerminalSend(Box::new(serde_json::from_value(value)?)),
            "terminal.wait" => Self::TerminalWait(Box::new(serde_json::from_value(value)?)),
            "terminal.keys" => Self::TerminalKeys(Box::new(serde_json::from_value(value)?)),
            "terminal.interrupt" => {
                Self::TerminalInterrupt(Box::new(serde_json::from_value(value)?))
            }
            "terminal.put" => Self::TerminalPut(Box::new(serde_json::from_value(value)?)),
            "machine.exec" => Self::MachineExec(Box::new(serde_json::from_value(value)?)),
            "file.read" => Self::FileRead(Box::new(serde_json::from_value(value)?)),
            "file.write" => Self::FileWrite(Box::new(serde_json::from_value(value)?)),
            "file.edit" => Self::FileEdit(Box::new(serde_json::from_value(value)?)),
            "doc.get" => Self::DocGet(Box::new(serde_json::from_value(value)?)),
            "doc.set" => Self::DocSet(Box::new(serde_json::from_value(value)?)),
            "events.subscribe" => Self::EventsSubscribe(Box::new(serde_json::from_value(value)?)),
            "machine.add" => Self::MachineAdd(Box::new(serde_json::from_value(value)?)),
            "machine.list" => Self::MachineList(Box::new(serde_json::from_value(value)?)),
            "machine.connect" => Self::MachineConnect(Box::new(serde_json::from_value(value)?)),
            "machine.rename" => Self::MachineRename(Box::new(serde_json::from_value(value)?)),
            "machine.rm" => Self::MachineRm(Box::new(serde_json::from_value(value)?)),
            "rpc.discover" => Self::RpcDiscover(Box::new(serde_json::from_value(value)?)),
            _ => return Err(Error::MissingMethod(method.into())),
        })
    }
    pub fn hello(params: HelloParams) -> Self {
        Self::Hello(Box::new(params))
    }
    pub fn server_status(params: ServerStatusParams) -> Self {
        Self::ServerStatus(Box::new(params))
    }
    pub fn server_stop(params: ServerStopParams) -> Self {
        Self::ServerStop(Box::new(params))
    }
    pub fn server_restart(params: ServerRestartParams) -> Self {
        Self::ServerRestart(Box::new(params))
    }
    pub fn terminal_run(params: TerminalRunParams) -> Self {
        Self::TerminalRun(Box::new(params))
    }
    pub fn templates_list(params: TemplatesListParams) -> Self {
        Self::TemplatesList(Box::new(params))
    }
    pub fn terminal_list(params: TerminalListParams) -> Self {
        Self::TerminalList(Box::new(params))
    }
    pub fn terminal_get(params: TerminalGetParams) -> Self {
        Self::TerminalGet(Box::new(params))
    }
    pub fn terminal_kill(params: TerminalKillParams) -> Self {
        Self::TerminalKill(Box::new(params))
    }
    pub fn terminal_rm(params: TerminalRmParams) -> Self {
        Self::TerminalRm(Box::new(params))
    }
    pub fn terminal_keep(params: TerminalKeepParams) -> Self {
        Self::TerminalKeep(Box::new(params))
    }
    pub fn terminal_label(params: TerminalLabelParams) -> Self {
        Self::TerminalLabel(Box::new(params))
    }
    pub fn terminal_read(params: TerminalReadParams) -> Self {
        Self::TerminalRead(Box::new(params))
    }
    pub fn terminal_attach(params: TerminalAttachParams) -> Self {
        Self::TerminalAttach(Box::new(params))
    }
    pub fn terminal_send(params: TerminalSendParams) -> Self {
        Self::TerminalSend(Box::new(params))
    }
    pub fn terminal_wait(params: TerminalWaitParams) -> Self {
        Self::TerminalWait(Box::new(params))
    }
    pub fn terminal_keys(params: TerminalKeysParams) -> Self {
        Self::TerminalKeys(Box::new(params))
    }
    pub fn terminal_interrupt(params: TerminalInterruptParams) -> Self {
        Self::TerminalInterrupt(Box::new(params))
    }
    pub fn terminal_put(params: TerminalPutParams) -> Self {
        Self::TerminalPut(Box::new(params))
    }
    pub fn machine_exec(params: MachineExecParams) -> Self {
        Self::MachineExec(Box::new(params))
    }
    pub fn file_read(params: FileReadParams) -> Self {
        Self::FileRead(Box::new(params))
    }
    pub fn file_write(params: FileWriteParams) -> Self {
        Self::FileWrite(Box::new(params))
    }
    pub fn file_edit(params: FileEditParams) -> Self {
        Self::FileEdit(Box::new(params))
    }
    pub fn doc_get(params: DocGetParams) -> Self {
        Self::DocGet(Box::new(params))
    }
    pub fn doc_set(params: DocSetParams) -> Self {
        Self::DocSet(Box::new(params))
    }
    pub fn events_subscribe(params: EventsSubscribeParams) -> Self {
        Self::EventsSubscribe(Box::new(params))
    }
    pub fn machine_add(params: MachineAddParams) -> Self {
        Self::MachineAdd(Box::new(params))
    }
    pub fn machine_list(params: MachineListParams) -> Self {
        Self::MachineList(Box::new(params))
    }
    pub fn machine_connect(params: MachineConnectParams) -> Self {
        Self::MachineConnect(Box::new(params))
    }
    pub fn machine_rename(params: MachineRenameParams) -> Self {
        Self::MachineRename(Box::new(params))
    }
    pub fn machine_rm(params: MachineRmParams) -> Self {
        Self::MachineRm(Box::new(params))
    }
    pub fn rpc_discover(params: RpcDiscoverParams) -> Self {
        Self::RpcDiscover(Box::new(params))
    }
    pub fn method(&self) -> &'static str {
        match self {
            Self::Hello(..) => "hello",
            Self::ServerStatus(..) => "server.status",
            Self::ServerStop(..) => "server.stop",
            Self::ServerRestart(..) => "server.restart",
            Self::TerminalRun(..) => "terminal.run",
            Self::TemplatesList(..) => "templates.list",
            Self::TerminalList(..) => "terminal.list",
            Self::TerminalGet(..) => "terminal.get",
            Self::TerminalKill(..) => "terminal.kill",
            Self::TerminalRm(..) => "terminal.rm",
            Self::TerminalKeep(..) => "terminal.keep",
            Self::TerminalLabel(..) => "terminal.label",
            Self::TerminalRead(..) => "terminal.read",
            Self::TerminalAttach(..) => "terminal.attach",
            Self::TerminalSend(..) => "terminal.send",
            Self::TerminalWait(..) => "terminal.wait",
            Self::TerminalKeys(..) => "terminal.keys",
            Self::TerminalInterrupt(..) => "terminal.interrupt",
            Self::TerminalPut(..) => "terminal.put",
            Self::MachineExec(..) => "machine.exec",
            Self::FileRead(..) => "file.read",
            Self::FileWrite(..) => "file.write",
            Self::FileEdit(..) => "file.edit",
            Self::DocGet(..) => "doc.get",
            Self::DocSet(..) => "doc.set",
            Self::EventsSubscribe(..) => "events.subscribe",
            Self::MachineAdd(..) => "machine.add",
            Self::MachineList(..) => "machine.list",
            Self::MachineConnect(..) => "machine.connect",
            Self::MachineRename(..) => "machine.rename",
            Self::MachineRm(..) => "machine.rm",
            Self::RpcDiscover(..) => "rpc.discover",
        }
    }
    pub fn params(&self) -> Result<Value, Error> {
        Ok(match self {
            Self::Hello(p) => serde_json::to_value(p)?,
            Self::ServerStatus(p) => serde_json::to_value(p)?,
            Self::ServerStop(p) => serde_json::to_value(p)?,
            Self::ServerRestart(p) => serde_json::to_value(p)?,
            Self::TerminalRun(p) => serde_json::to_value(p)?,
            Self::TemplatesList(p) => serde_json::to_value(p)?,
            Self::TerminalList(p) => serde_json::to_value(p)?,
            Self::TerminalGet(p) => serde_json::to_value(p)?,
            Self::TerminalKill(p) => serde_json::to_value(p)?,
            Self::TerminalRm(p) => serde_json::to_value(p)?,
            Self::TerminalKeep(p) => serde_json::to_value(p)?,
            Self::TerminalLabel(p) => serde_json::to_value(p)?,
            Self::TerminalRead(p) => serde_json::to_value(p)?,
            Self::TerminalAttach(p) => serde_json::to_value(p)?,
            Self::TerminalSend(p) => serde_json::to_value(p)?,
            Self::TerminalWait(p) => serde_json::to_value(p)?,
            Self::TerminalKeys(p) => serde_json::to_value(p)?,
            Self::TerminalInterrupt(p) => serde_json::to_value(p)?,
            Self::TerminalPut(p) => serde_json::to_value(p)?,
            Self::MachineExec(p) => serde_json::to_value(p)?,
            Self::FileRead(p) => serde_json::to_value(p)?,
            Self::FileWrite(p) => serde_json::to_value(p)?,
            Self::FileEdit(p) => serde_json::to_value(p)?,
            Self::DocGet(p) => serde_json::to_value(p)?,
            Self::DocSet(p) => serde_json::to_value(p)?,
            Self::EventsSubscribe(p) => serde_json::to_value(p)?,
            Self::MachineAdd(p) => serde_json::to_value(p)?,
            Self::MachineList(p) => serde_json::to_value(p)?,
            Self::MachineConnect(p) => serde_json::to_value(p)?,
            Self::MachineRename(p) => serde_json::to_value(p)?,
            Self::MachineRm(p) => serde_json::to_value(p)?,
            Self::RpcDiscover(p) => serde_json::to_value(p)?,
        })
    }
    pub fn decode(&self, value: Value) -> Result<Response, Error> {
        Ok(match self {
            Self::Hello(..) => Response::Hello(Box::new(serde_json::from_value(value)?)),
            Self::ServerStatus(..) => {
                Response::ServerStatus(Box::new(serde_json::from_value(value)?))
            }
            Self::ServerStop(..) => Response::ServerStop(Box::new(serde_json::from_value(value)?)),
            Self::ServerRestart(..) => {
                Response::ServerRestart(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalRun(..) => {
                Response::TerminalRun(Box::new(serde_json::from_value(value)?))
            }
            Self::TemplatesList(..) => {
                Response::TemplatesList(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalList(..) => {
                Response::TerminalList(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalGet(..) => {
                Response::TerminalGet(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalKill(..) => {
                Response::TerminalKill(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalRm(..) => Response::TerminalRm(Box::new(serde_json::from_value(value)?)),
            Self::TerminalKeep(..) => {
                Response::TerminalKeep(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalLabel(..) => {
                Response::TerminalLabel(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalRead(..) => {
                Response::TerminalRead(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalAttach(..) => {
                Response::TerminalAttach(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalSend(..) => {
                Response::TerminalSend(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalWait(..) => {
                Response::TerminalWait(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalKeys(..) => {
                Response::TerminalKeys(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalInterrupt(..) => {
                Response::TerminalInterrupt(Box::new(serde_json::from_value(value)?))
            }
            Self::TerminalPut(..) => {
                Response::TerminalPut(Box::new(serde_json::from_value(value)?))
            }
            Self::MachineExec(..) => {
                Response::MachineExec(Box::new(serde_json::from_value(value)?))
            }
            Self::FileRead(..) => Response::FileRead(Box::new(serde_json::from_value(value)?)),
            Self::FileWrite(..) => Response::FileWrite(Box::new(serde_json::from_value(value)?)),
            Self::FileEdit(..) => Response::FileEdit(Box::new(serde_json::from_value(value)?)),
            Self::DocGet(..) => Response::DocGet(Box::new(serde_json::from_value(value)?)),
            Self::DocSet(..) => Response::DocSet(Box::new(serde_json::from_value(value)?)),
            Self::EventsSubscribe(..) => {
                Response::EventsSubscribe(Box::new(serde_json::from_value(value)?))
            }
            Self::MachineAdd(..) => Response::MachineAdd(Box::new(serde_json::from_value(value)?)),
            Self::MachineList(..) => {
                Response::MachineList(Box::new(serde_json::from_value(value)?))
            }
            Self::MachineConnect(..) => {
                Response::MachineConnect(Box::new(serde_json::from_value(value)?))
            }
            Self::MachineRename(..) => {
                Response::MachineRename(Box::new(serde_json::from_value(value)?))
            }
            Self::MachineRm(..) => Response::MachineRm(Box::new(serde_json::from_value(value)?)),
            Self::RpcDiscover(..) => {
                Response::RpcDiscover(Box::new(serde_json::from_value(value)?))
            }
        })
    }
    pub fn opens_channel(&self) -> bool {
        matches!(self, Self::TerminalAttach(..) | Self::EventsSubscribe(..))
    }
}
impl Response {
    pub fn as_value(&self) -> Result<Value, Error> {
        Ok(match self {
            Self::Hello(v) => serde_json::to_value(v)?,
            Self::ServerStatus(v) => serde_json::to_value(v)?,
            Self::ServerStop(v) | Self::ServerRestart(v) => serde_json::to_value(v)?,
            Self::TerminalRun(v) => serde_json::to_value(v)?,
            Self::TemplatesList(v) => serde_json::to_value(v)?,
            Self::TerminalList(v) => serde_json::to_value(v)?,
            Self::TerminalGet(v)
            | Self::TerminalKill(v)
            | Self::TerminalKeep(v)
            | Self::TerminalLabel(v) => serde_json::to_value(v)?,
            Self::TerminalRm(v) | Self::MachineRm(v) => serde_json::to_value(v)?,
            Self::TerminalRead(v) => serde_json::to_value(v)?,
            Self::TerminalAttach(v) => serde_json::to_value(v)?,
            Self::TerminalSend(v) => serde_json::to_value(v)?,
            Self::TerminalWait(v) => serde_json::to_value(v)?,
            Self::TerminalKeys(v) => serde_json::to_value(v)?,
            Self::TerminalInterrupt(v) => serde_json::to_value(v)?,
            Self::TerminalPut(v) => serde_json::to_value(v)?,
            Self::MachineExec(v) => serde_json::to_value(v)?,
            Self::FileRead(v) => serde_json::to_value(v)?,
            Self::FileWrite(v) | Self::FileEdit(v) => serde_json::to_value(v)?,
            Self::DocGet(v) => serde_json::to_value(v)?,
            Self::DocSet(v) => serde_json::to_value(v)?,
            Self::EventsSubscribe(v) => serde_json::to_value(v)?,
            Self::MachineAdd(v) | Self::MachineRename(v) => serde_json::to_value(v)?,
            Self::MachineList(v) => serde_json::to_value(v)?,
            Self::MachineConnect(v) => serde_json::to_value(v)?,
            Self::RpcDiscover(v) => serde_json::to_value(v)?,
        })
    }
    pub fn stream_channel(&self) -> Option<u32> {
        match self {
            Self::TerminalAttach(v) => Some(v.channel),
            Self::EventsSubscribe(v) => v.channel,
            _ => None,
        }
    }
}
pub const METHODS: &[&str] = &[
    "hello",
    "server.status",
    "server.stop",
    "server.restart",
    "terminal.run",
    "templates.list",
    "terminal.list",
    "terminal.get",
    "terminal.kill",
    "terminal.rm",
    "terminal.keep",
    "terminal.label",
    "terminal.read",
    "terminal.attach",
    "terminal.send",
    "terminal.wait",
    "terminal.keys",
    "terminal.interrupt",
    "terminal.put",
    "machine.exec",
    "file.read",
    "file.write",
    "file.edit",
    "doc.get",
    "doc.set",
    "events.subscribe",
    "machine.add",
    "machine.list",
    "machine.connect",
    "machine.rename",
    "machine.rm",
    "rpc.discover",
];
