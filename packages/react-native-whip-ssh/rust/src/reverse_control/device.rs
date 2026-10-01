//! Device protocol and validation. Platform adapters only perform native calls.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::browser::model::{BrowserError, ErrorCode};

const INFO: &str = "device.info";
const BATTERY: &str = "device.battery";
const LOCATION: &str = "device.location";
const HAPTIC: &str = "device.haptic";
const CLIPBOARD_READ: &str = "device.clipboard_read";
const CLIPBOARD_WRITE: &str = "device.clipboard_write";
const NOTIFY: &str = "device.notify";
const SPEAK: &str = "device.speak";
const STOP_SPEAKING: &str = "device.stop_speaking";
const NETWORK: &str = "device.network";
const SENSOR: &str = "device.sensor_snapshot";
const MOTION: &str = "device.motion";
const MAX_CLIPBOARD: usize = 16_384;
const MAX_TITLE: usize = 160;
const MAX_BODY: usize = 4096;
const MAX_SPEECH: usize = 2000;
pub const NAMES: &[&str] = &[
    INFO,
    BATTERY,
    LOCATION,
    HAPTIC,
    CLIPBOARD_READ,
    CLIPBOARD_WRITE,
    NOTIFY,
    SPEAK,
    STOP_SPEAKING,
    NETWORK,
    SENSOR,
    MOTION,
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClipboardReadArgs {
    #[serde(default = "clipboard_limit")]
    pub max_chars: usize,
}
const fn clipboard_limit() -> usize {
    MAX_CLIPBOARD
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TextArgs {
    pub text: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NotifyArgs {
    pub title: String,
    pub body: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeakArgs {
    pub text: String,
    pub language: Option<String>,
    #[serde(default = "speech_rate")]
    pub rate: f64,
}
const fn speech_rate() -> f64 {
    1.0
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SensorKind {
    Accelerometer,
    Gyroscope,
    Magnetometer,
    Barometer,
}
impl SensorKind {
    fn unit(self) -> &'static str {
        match self {
            Self::Accelerometer => "m/s2",
            Self::Gyroscope => "rad/s",
            Self::Magnetometer => "uT",
            Self::Barometer => "hPa",
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SensorArgs {
    pub sensor: SensorKind,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HapticStyle {
    Light,
    Medium,
    Heavy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HapticArgs {
    pub style: HapticStyle,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}

pub enum DeviceAction {
    Info,
    Battery,
    Location,
    Haptic(HapticArgs),
    ClipboardRead(ClipboardReadArgs),
    ClipboardWrite(TextArgs),
    Notify(NotifyArgs),
    Speak(SpeakArgs),
    StopSpeaking,
    Network,
    Sensor(SensorArgs),
    Motion,
}

impl DeviceAction {
    pub fn parse(name: &str, arguments: &Value) -> Result<Self, BrowserError> {
        let arguments = if arguments.is_null() {
            json!({})
        } else {
            arguments.clone()
        };
        if !arguments.is_object() {
            return Err(BrowserError::invalid("Device arguments must be an object"));
        }
        let action = match name {
            HAPTIC => Self::Haptic(arguments_as(arguments)?),
            CLIPBOARD_READ => Self::ClipboardRead(arguments_as(arguments)?),
            CLIPBOARD_WRITE => Self::ClipboardWrite(arguments_as(arguments)?),
            NOTIFY => Self::Notify(arguments_as(arguments)?),
            SPEAK => Self::Speak(arguments_as(arguments)?),
            SENSOR => Self::Sensor(arguments_as(arguments)?),
            INFO | BATTERY | LOCATION | STOP_SPEAKING | NETWORK | MOTION => {
                let _: EmptyArgs = arguments_as(arguments)?;
                match name {
                    INFO => Self::Info,
                    BATTERY => Self::Battery,
                    LOCATION => Self::Location,
                    STOP_SPEAKING => Self::StopSpeaking,
                    MOTION => Self::Motion,
                    _ => Self::Network,
                }
            }
            _ => {
                return Err(BrowserError::new(
                    ErrorCode::UnknownAction,
                    "Unknown device tool",
                ));
            }
        };
        match &action {
            Self::ClipboardRead(args) if !(1..=MAX_CLIPBOARD).contains(&args.max_chars) => {
                return Err(BrowserError::invalid(
                    "Clipboard max_chars must be 1..16384",
                ));
            }
            Self::ClipboardWrite(args) => valid_text(&args.text, MAX_CLIPBOARD, true)?,
            Self::Notify(args) => {
                valid_text(&args.title, MAX_TITLE, false)?;
                valid_text(&args.body, MAX_BODY, true)?;
            }
            Self::Speak(args) => {
                valid_text(&args.text, MAX_SPEECH, false)?;
                if !(0.5..=2.0).contains(&args.rate) {
                    return Err(BrowserError::invalid("Speech rate must be 0.5..2"));
                }
                if let Some(language) = &args.language {
                    valid_text(language, 35, false)?;
                    if !language
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    {
                        return Err(BrowserError::invalid(
                            "Speech language must be a BCP-47 tag",
                        ));
                    }
                }
            }
            _ => {}
        }
        Ok(action)
    }

    pub fn wire(&self) -> (&'static str, Value) {
        match self {
            Self::Info => (INFO, json!({})),
            Self::Battery => (BATTERY, json!({})),
            Self::Location => (LOCATION, json!({})),
            Self::Haptic(args) => (HAPTIC, json!(args)),
            Self::ClipboardRead(args) => (CLIPBOARD_READ, json!(args)),
            Self::ClipboardWrite(args) => (CLIPBOARD_WRITE, json!(args)),
            Self::Notify(args) => (NOTIFY, json!(args)),
            Self::Speak(args) => (SPEAK, json!(args)),
            Self::StopSpeaking => (STOP_SPEAKING, json!({})),
            Self::Network => (NETWORK, json!({})),
            Self::Sensor(args) => (SENSOR, json!(args)),
            Self::Motion => (MOTION, json!({})),
        }
    }

    pub fn result(&self, value: Value) -> Result<Value, BrowserError> {
        if value.to_string().len() > super::browser::model::MAX_TEXT_RESULT {
            return Err(BrowserError::new(
                ErrorCode::ResultTooLarge,
                "Device response too large",
            ));
        }
        // Decode and re-encode typed results so native adapters cannot accidentally
        // export extra fields (such as stable device identifiers).
        let value = match self {
            Self::Info => json!(decode::<Info>(value)?),
            Self::Battery => {
                let result: Battery = decode(value)?;
                if result
                    .level
                    .is_some_and(|level| !(0.0..=1.0).contains(&level))
                {
                    return Err(invalid_result());
                }
                json!(result)
            }
            Self::Location => {
                let result: Location = decode(value)?;
                if !(-90.0..=90.0).contains(&result.latitude)
                    || !(-180.0..=180.0).contains(&result.longitude)
                    || result.accuracy_m < 0.0
                    || result.timestamp_ms <= 0.0
                {
                    return Err(invalid_result());
                }
                json!(result)
            }
            Self::Haptic(_) => json!(decode::<HapticResult>(value)?),
            Self::ClipboardRead(args) => {
                let result: ClipboardResult = decode(value)?;
                if result.text.chars().count() > args.max_chars {
                    return Err(invalid_result());
                }
                json!(result)
            }
            Self::ClipboardWrite(_) => json!(decode::<WriteResult>(value)?),
            Self::Notify(_) => {
                let result: NotificationResult = decode(value)?;
                if result.notification_id.is_empty() || result.notification_id.len() > 256 {
                    return Err(invalid_result());
                }
                json!(result)
            }
            Self::Speak(_) => json!(decode::<SpeechResult>(value)?),
            Self::StopSpeaking => json!(decode::<StopResult>(value)?),
            Self::Motion => motion_result(value)?,
            Self::Network => {
                let result: NetworkResult = decode(value)?;
                if (result.connection_type == ConnectionType::Offline && result.connected)
                    || (!result.connected && result.internet_reachable == Some(true))
                {
                    return Err(invalid_result());
                }
                json!(result)
            }
            Self::Sensor(args) => {
                let mut result: SensorResult = decode(value)?;
                if result.sensor != args.sensor
                    || result.unit != args.sensor.unit()
                    || result.timestamp_ms <= 0.0
                {
                    return Err(invalid_result());
                }
                result.reading = if args.sensor == SensorKind::Barometer {
                    let reading: Pressure = decode(result.reading)?;
                    if reading.pressure <= 0.0 {
                        return Err(invalid_result());
                    }
                    json!(reading)
                } else {
                    json!(decode::<Vector>(result.reading)?)
                };
                json!(result)
            }
        };
        let result = json!({"kind": self.wire().0, "value": value});
        Ok(
            json!({"structuredContent":result,"content":[{"type":"text","text":result.to_string()}]}),
        )
    }
}

fn arguments_as<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, BrowserError> {
    serde_json::from_value(value)
        .map_err(|_| BrowserError::invalid("Invalid device tool arguments"))
}
fn valid_text(text: &str, maximum: usize, empty: bool) -> Result<(), BrowserError> {
    if (!empty && text.trim().is_empty()) || text.chars().count() > maximum {
        return Err(BrowserError::invalid("Device text outside allowed size"));
    }
    Ok(())
}

fn invalid_result() -> BrowserError {
    BrowserError::new(ErrorCode::InvalidResult, "Malformed native device result")
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, BrowserError> {
    serde_json::from_value(value).map_err(|_| invalid_result())
}

#[derive(Deserialize, Serialize)]
struct Info {
    platform: String,
    os_version: String,
    model: String,
    manufacturer: String,
    app_version: Option<String>,
    locale: String,
    time_zone: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum BatteryState {
    Unknown,
    Unplugged,
    Charging,
    Full,
}
#[derive(Deserialize, Serialize)]
struct Battery {
    level: Option<f64>,
    state: BatteryState,
    low_power_mode: bool,
}
#[derive(Deserialize, Serialize)]
struct Location {
    latitude: f64,
    longitude: f64,
    accuracy_m: f64,
    timestamp_ms: f64,
}
#[derive(Deserialize, Serialize)]
struct HapticResult {
    performed: bool,
}
#[derive(Deserialize, Serialize)]
struct ClipboardResult {
    text: String,
    truncated: bool,
}
#[derive(Deserialize, Serialize)]
struct WriteResult {
    written: bool,
}
#[derive(Deserialize, Serialize)]
struct NotificationResult {
    notification_id: String,
}
#[derive(Deserialize, Serialize)]
struct SpeechResult {
    started: bool,
}
#[derive(Deserialize, Serialize)]
struct StopResult {
    stopped: bool,
}
#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ConnectionType {
    Offline,
    Wifi,
    Cellular,
    Ethernet,
    Vpn,
    Other,
    Unknown,
}
#[derive(Deserialize, Serialize)]
struct NetworkResult {
    connected: bool,
    connection_type: ConnectionType,
    internet_reachable: Option<bool>,
    is_expensive: bool,
    low_data_mode: Option<bool>,
}
#[derive(Deserialize, Serialize)]
struct SensorResult {
    sensor: SensorKind,
    unit: String,
    timestamp_ms: f64,
    reading: Value,
}
#[derive(Deserialize, Serialize)]
struct Vector {
    x: f64,
    y: f64,
    z: f64,
}
#[derive(Deserialize, Serialize)]
struct Pressure {
    pressure: f64,
}

#[derive(Deserialize, Serialize)]
struct MotionVector {
    #[serde(flatten)]
    vector: Vector,
    timestamp: f64,
}
#[derive(Deserialize, Serialize)]
struct MotionRotation {
    alpha: f64,
    beta: f64,
    gamma: f64,
    timestamp: f64,
}
#[derive(Deserialize, Serialize)]
struct MotionResult {
    timestamp_ms: f64,
    interval_ms: f64,
    orientation: i16,
    acceleration: Option<MotionVector>,
    #[serde(rename = "accelerationIncludingGravity")]
    acceleration_including_gravity: MotionVector,
    rotation: MotionRotation,
    #[serde(rename = "rotationRate")]
    rotation_rate: Option<MotionRotation>,
}

fn motion_result(value: Value) -> Result<Value, BrowserError> {
    let result: MotionResult = decode(value)?;
    if result.timestamp_ms <= 0.0
        || result.interval_ms < 0.0
        || ![-90, 0, 90, 180].contains(&result.orientation)
        || result.acceleration_including_gravity.timestamp < 0.0
        || result.rotation.timestamp < 0.0
        || result
            .acceleration
            .as_ref()
            .is_some_and(|v| v.timestamp < 0.0)
        || result
            .rotation_rate
            .as_ref()
            .is_some_and(|v| v.timestamp < 0.0)
    {
        return Err(invalid_result());
    }
    let mut value = json!(result);
    value["units"] = json!({
        "acceleration":"m/s2", "rotation":"rad", "rotationRate":"deg/s",
        "orientation":"deg", "timestamp":"s", "interval_ms":"ms"
    });
    Ok(value)
}

pub fn tools() -> Vec<Value> {
    NAMES.iter().map(|name| {
        let (description, properties, required) = match *name {
            INFO => ("Use for phone environment, locale or time-zone context. Read the phone's platform, OS, model, app version, locale and time zone. Does not return unique identifiers.", json!({}), json!([])),
            BATTERY => ("Use for phone charge and power-state questions. Read current battery level (0..1 or null), charging state and low-power mode.", json!({}), json!([])),
            LOCATION => ("Use for nearby places, local weather or tasks needing the user's current phone position. Get one foreground location fix from the phone, with latitude, longitude, accuracy_m and timestamp_ms. Requests OS permission if needed; approximate access is supported. Requires Whip to be foregrounded. Stops on cancellation or timeout; never tracks in the background.", json!({}), json!([])),
            CLIPBOARD_READ => ("Use to retrieve text or a link the user copied on the phone. Read foreground phone clipboard text, bounded by max_chars. Returns text and truncated; may show an OS paste permission prompt.", json!({"max_chars":{"type":"integer","minimum":1,"maximum":MAX_CLIPBOARD,"default":MAX_CLIPBOARD}}), json!([])),
            CLIPBOARD_WRITE => ("Use to put a result or link on the phone clipboard for pasting. Replace foreground phone clipboard text; empty text clears it.", json!({"text":{"type":"string","maxLength":MAX_CLIPBOARD}}), json!(["text"])),
            NOTIFY => ("Use for phone alerts and task completion notices. Show one immediate local notification. Requests OS notification permission if necessary while Whip is foregrounded. Tapping returns to this launch's pane.", json!({"title":{"type":"string","minLength":1,"maxLength":MAX_TITLE},"body":{"type":"string","maxLength":MAX_BODY}}), json!(["title","body"])),
            SPEAK => ("Use for requested spoken feedback or reading text aloud. Start speaking text on the phone and return immediately. Optional BCP-47 language and rate (0.5..2). Stops on completion, after 60 seconds, stop_speaking, or session close. One reverse-control session speaks at a time; other sessions cannot stop it.", json!({"text":{"type":"string","minLength":1,"maxLength":MAX_SPEECH},"language":{"type":"string","minLength":1,"maxLength":35},"rate":{"type":"number","minimum":0.5,"maximum":2,"default":1}}), json!(["text"])),
            STOP_SPEAKING => ("Stop speech started by this reverse-control session. Does not stop another session's speech or Whip's existing speech player.", json!({}), json!([])),
            NETWORK => ("Use to diagnose the phone's connectivity. Read current phone connection type, connected, internet_reachable, is_expensive and low_data_mode. Unsupported checks return null; iOS does not probe internet reachability. No SSID, IP addresses or credentials are exported.", json!({}), json!([])),
            SENSOR => ("Use for raw hardware measurements such as angular velocity, magnetic field or air pressure. Take one foreground sensor reading, then stop sampling. Times out after five seconds; unsupported hardware returns sensor_unavailable. Result includes sensor, timestamp_ms, unit and reading: {x,y,z} or {pressure}. Accelerometer includes gravity (m/s2); gyroscope rad/s; magnetometer uT; barometer hPa.", json!({"sensor":{"type":"string","enum":["accelerometer","gyroscope","magnetometer","barometer"]}}), json!(["sensor"])),
            MOTION => ("Use for phone orientation, fused attitude and movement with gravity-separated acceleration. Take one foreground Expo DeviceMotion snapshot, then unsubscribe. Includes screen orientation (degrees), rotation/attitude (radians), rotationRate (degrees/second), acceleration and accelerationIncludingGravity (m/s2), interval_ms, capture timestamp_ms (Unix ms), and component timestamps (seconds since boot). Acceleration or rotationRate may be null. Requests motion permission if needed. Sampling times out after five seconds; missing hardware returns sensor_unavailable.", json!({}), json!([])),
            _ => ("Use for a brief tactile cue. Trigger one short haptic feedback on the phone.", json!({"style":{"type":"string","enum":["light","medium","heavy"]}}), json!(["style"])),
        };
        json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
    }).collect()
}
