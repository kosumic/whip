//! Herdr terminal client protocol compatibility for versions 17 through 22.
//!
//! The message shapes and bincode configuration mirror Herdr's
//! `src/protocol/wire.rs`.  Keep the explicit version table below: protocol 18
//! inserted `KittyKeyboardReportAll` before `PrefixInputSource`, and protocol
//! 20 appended `TerminalBell`. Protocol 22 replaced the direct-terminal
//! handshake and server message layout while keeping the terminal attach,
//! input, and scroll operations at their existing tags.

use std::fmt;

pub const MIN_PROTOCOL: u32 = 17;
pub const MAX_PROTOCOL: u32 = 22;
pub const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

// The published protocol-21 preview retained the legacy wire layout. Protocol
// 22 is the first distributed version of the endpoint-generation-1 layout.
const MODERN_PROTOCOL: u32 = 22;
const KITTY_FLAG_REPORT_ALL_KEYS: u16 = 0b0000_1000;
const SERVER_KEYBINDINGS: u64 = 0;
const MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;
const SERVER_WELCOME: u64 = 0;
const LEGACY_SERVER_TERMINAL: u64 = 2;
const LEGACY_SERVER_GRAPHICS: u64 = 3;
const LEGACY_SERVER_CLOSED: u64 = 4;
const LEGACY_SERVER_NOTIFY: u64 = 5;
const LEGACY_SERVER_CLIPBOARD: u64 = 6;
const LEGACY_SERVER_TITLE: u64 = 7;
const LEGACY_SERVER_RELOAD_SOUND_CONFIG: u64 = 8;
const LEGACY_SERVER_MOUSE_CAPTURE: u64 = 9;
const LEGACY_SERVER_PREFIX_INPUT_SOURCE_V17: u64 = 10;
const LEGACY_SERVER_KITTY_KEYBOARD_REPORT_ALL: u64 = 10;
const LEGACY_SERVER_PREFIX_INPUT_SOURCE: u64 = 11;
const LEGACY_SERVER_TERMINAL_BELL: u64 = 12;
const MODERN_SERVER_TERMINAL: u64 = 1;
const MODERN_SERVER_GRAPHICS: u64 = 2;
const MODERN_SERVER_CLOSED: u64 = 3;
const MODERN_SERVER_NOTIFY: u64 = 4;
const MODERN_SERVER_CLIPBOARD: u64 = 5;
const MODERN_SERVER_TITLE: u64 = 6;
const MODERN_SERVER_RELOAD_SOUND_CONFIG: u64 = 7;
const MODERN_SERVER_MOUSE_CAPTURE: u64 = 8;
const MODERN_SERVER_TERMINAL_BELL: u64 = 9;
const MODERN_SERVER_DIRECT_TERMINAL_KEYBOARD_PROTOCOL: u64 = 16;

#[repr(u64)]
enum ClientMessageTag {
    Hello = 0,
    Input = 1,
    Resize = 3,
    Detach = 4,
    Attach = 5,
    Scroll = 6,
}

#[repr(u64)]
enum AttachScrollSource {
    Wheel = 0,
}

#[repr(u64)]
enum AttachScrollDirection {
    Up = 0,
    Down = 1,
}

/// The terminal-attach variant moved from bincode discriminant 1 to 2 when
/// protocol 20 inserted `AppDirectGraphics` into Herdr's `ClientLaunchMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrTerminalAttachLaunchMode {
    LegacyTerminalAttach,
    TerminalAttach,
}

impl HerdrTerminalAttachLaunchMode {
    pub(crate) const fn for_protocol(protocol: u32) -> Self {
        if protocol >= 20 {
            Self::TerminalAttach
        } else {
            Self::LegacyTerminalAttach
        }
    }

    const fn wire_value(self) -> u8 {
        match self {
            Self::LegacyTerminalAttach => 1,
            Self::TerminalAttach => 2,
        }
    }
}

impl TryFrom<u8> for HerdrTerminalAttachLaunchMode {
    type Error = CodecError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::LegacyTerminalAttach),
            2 => Ok(Self::TerminalAttach),
            value => Err(CodecError::UnsupportedLaunchMode(value)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrTerminalNotificationKind {
    Sound,
    Toast,
    SystemToast,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HerdrTerminalEncoding {
    TerminalAnsi,
}

impl HerdrTerminalEncoding {
    const fn wire_value(self) -> u32 {
        match self {
            Self::TerminalAnsi => 1,
        }
    }
}

impl TryFrom<u32> for HerdrTerminalEncoding {
    type Error = u32;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::TerminalAnsi),
            value => Err(value),
        }
    }
}

impl TryFrom<u64> for HerdrTerminalNotificationKind {
    type Error = CodecError;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Sound),
            1 => Ok(Self::Toast),
            2 => Ok(Self::SystemToast),
            value => Err(CodecError::InvalidNotificationKind(value)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodecError {
    UnsupportedProtocol(u32),
    UnsupportedLaunchMode(u8),
    InvalidValue(&'static str),
    Truncated(&'static str),
    InvalidIntegerMarker(u8),
    IntegerOverflow,
    InvalidBoolean(u8),
    InvalidOptionTag(u8),
    InvalidNotificationKind(u64),
    InvalidBellCount(u64),
}

impl fmt::Display for CodecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedProtocol(protocol) => write!(
                formatter,
                "Herdr protocol mismatch: client supports {MIN_PROTOCOL} through {MAX_PROTOCOL}, server reports {protocol}",
            ),
            Self::UnsupportedLaunchMode(mode) => {
                write!(
                    formatter,
                    "unsupported Herdr terminal attach launch mode {mode}"
                )
            }
            Self::InvalidValue(name) => write!(formatter, "invalid Herdr {name}"),
            Self::Truncated(context) => write!(formatter, "unexpected end of {context}"),
            Self::InvalidIntegerMarker(marker) => {
                write!(formatter, "unsupported bincode integer marker {marker}")
            }
            Self::IntegerOverflow => {
                write!(formatter, "bincode value exceeds JavaScript integer range")
            }
            Self::InvalidBoolean(value) => write!(formatter, "invalid bincode bool {value}"),
            Self::InvalidOptionTag(tag) => write!(formatter, "invalid bincode option tag {tag}"),
            Self::InvalidNotificationKind(kind) => {
                write!(formatter, "invalid Herdr terminal notification kind {kind}")
            }
            Self::InvalidBellCount(count) => {
                write!(formatter, "invalid Herdr terminal bell count {count}")
            }
        }
    }
}

impl std::error::Error for CodecError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerMessage {
    Welcome {
        protocol: u32,
        encoding: u32,
        error: Option<String>,
    },
    Terminal {
        sequence: u64,
        width: u16,
        height: u16,
        full: bool,
        bytes: Vec<u8>,
    },
    Graphics {
        bytes: Vec<u8>,
    },
    Closed {
        reason: Option<String>,
    },
    Notify {
        kind: HerdrTerminalNotificationKind,
        text: String,
        body: Option<String>,
    },
    Clipboard {
        text: String,
    },
    Title {
        title: Option<String>,
    },
    ReloadSoundConfig,
    MouseCapture {
        enabled: bool,
    },
    KittyKeyboardReportAll {
        enabled: bool,
    },
    PrefixInputSource {
        enabled: bool,
    },
    TerminalBell {
        count: u16,
    },
    Ignored {
        variant: u64,
    },
}

#[derive(Default)]
struct Encoder {
    bytes: Vec<u8>,
}

impl Encoder {
    fn unsigned(&mut self, value: u64) {
        match value {
            0..=250 => self.bytes.push(value.to_le_bytes()[0]),
            251..=0xffff => {
                self.bytes.push(251);
                self.bytes.extend_from_slice(&value.to_le_bytes()[..2]);
            }
            0x1_0000..=0xffff_ffff => {
                self.bytes.push(252);
                self.bytes.extend_from_slice(&value.to_le_bytes()[..4]);
            }
            _ => {
                self.bytes.push(253);
                self.bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
    }

    fn boolean(&mut self, value: bool) {
        self.bytes.push(u8::from(value));
    }

    fn byte_string(&mut self, value: &[u8]) {
        self.unsigned(value.len() as u64);
        self.bytes.extend_from_slice(value);
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Decoder<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn byte(&mut self, context: &'static str) -> Result<u8, CodecError> {
        let value = self
            .bytes
            .get(self.offset)
            .copied()
            .ok_or(CodecError::Truncated(context))?;
        self.offset += 1;
        Ok(value)
    }

    fn take(&mut self, length: usize, context: &'static str) -> Result<&'a [u8], CodecError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(CodecError::IntegerOverflow)?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(CodecError::Truncated(context))?;
        self.offset = end;
        Ok(value)
    }

    fn unsigned(&mut self) -> Result<u64, CodecError> {
        let marker = self.byte("bincode payload")?;
        let value = match marker {
            0..=250 => u64::from(marker),
            251 => u64::from(u16::from_le_bytes(
                self.take(2, "bincode integer")?
                    .try_into()
                    .map_err(|_| CodecError::Truncated("bincode integer"))?,
            )),
            252 => u64::from(u32::from_le_bytes(
                self.take(4, "bincode integer")?
                    .try_into()
                    .map_err(|_| CodecError::Truncated("bincode integer"))?,
            )),
            253 => u64::from_le_bytes(
                self.take(8, "bincode integer")?
                    .try_into()
                    .map_err(|_| CodecError::Truncated("bincode integer"))?,
            ),
            _ => return Err(CodecError::InvalidIntegerMarker(marker)),
        };
        if value > MAX_SAFE_INTEGER {
            Err(CodecError::IntegerOverflow)
        } else {
            Ok(value)
        }
    }

    fn u32(&mut self, name: &'static str) -> Result<u32, CodecError> {
        u32::try_from(self.unsigned()?).map_err(|_| CodecError::InvalidValue(name))
    }

    fn u16(&mut self, name: &'static str) -> Result<u16, CodecError> {
        u16::try_from(self.unsigned()?).map_err(|_| CodecError::InvalidValue(name))
    }

    fn boolean(&mut self) -> Result<bool, CodecError> {
        match self.byte("bincode payload")? {
            0 => Ok(false),
            1 => Ok(true),
            value => Err(CodecError::InvalidBoolean(value)),
        }
    }

    fn byte_string(&mut self) -> Result<&'a [u8], CodecError> {
        let length = usize::try_from(self.unsigned()?).map_err(|_| CodecError::IntegerOverflow)?;
        self.take(length, "bincode byte string")
    }

    fn owned_bytes(&mut self) -> Result<Vec<u8>, CodecError> {
        Ok(self.byte_string()?.to_vec())
    }

    fn string(&mut self) -> Result<String, CodecError> {
        Ok(String::from_utf8_lossy(self.byte_string()?).into_owned())
    }

    fn option_string(&mut self) -> Result<Option<String>, CodecError> {
        match self.byte("bincode option")? {
            0 => Ok(None),
            1 => self.string().map(Some),
            tag => Err(CodecError::InvalidOptionTag(tag)),
        }
    }
}

pub fn validate_protocol(protocol: u32) -> Result<(), CodecError> {
    if (MIN_PROTOCOL..=MAX_PROTOCOL).contains(&protocol) {
        Ok(())
    } else {
        Err(CodecError::UnsupportedProtocol(protocol))
    }
}

pub fn hello(
    protocol: u32,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
    terminal_attach_launch_mode: HerdrTerminalAttachLaunchMode,
) -> Result<Vec<u8>, CodecError> {
    validate_protocol(protocol)?;
    let columns = u16::try_from(columns).map_err(|_| CodecError::InvalidValue("column count"))?;
    let rows = u16::try_from(rows).map_err(|_| CodecError::InvalidValue("row count"))?;
    let mut encoder = Encoder::default();
    encoder.unsigned(ClientMessageTag::Hello as u64);
    encoder.unsigned(u64::from(protocol));
    encoder.unsigned(u64::from(columns));
    encoder.unsigned(u64::from(rows));
    encoder.unsigned(u64::from(cell_width_px));
    encoder.unsigned(u64::from(cell_height_px));
    if protocol >= MODERN_PROTOCOL {
        // Whip currently reports cell-relative mouse coordinates. Do not
        // advertise exact SGR 1016 pixel geometry to the server.
        encoder.boolean(false);
    } else {
        encoder.unsigned(u64::from(HerdrTerminalEncoding::TerminalAnsi.wire_value()));
        encoder.unsigned(SERVER_KEYBINDINGS);
        encoder.unsigned(u64::from(terminal_attach_launch_mode.wire_value()));
    }
    Ok(encoder.finish())
}

pub fn input(data: &[u8]) -> Vec<u8> {
    let mut encoder = Encoder::default();
    encoder.unsigned(ClientMessageTag::Input as u64);
    encoder.byte_string(data);
    encoder.finish()
}

pub fn resize(
    protocol: u32,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
) -> Result<Vec<u8>, CodecError> {
    validate_protocol(protocol)?;
    let columns = u16::try_from(columns).map_err(|_| CodecError::InvalidValue("column count"))?;
    let rows = u16::try_from(rows).map_err(|_| CodecError::InvalidValue("row count"))?;
    let mut encoder = Encoder::default();
    encoder.unsigned(ClientMessageTag::Resize as u64);
    encoder.unsigned(u64::from(columns));
    encoder.unsigned(u64::from(rows));
    encoder.unsigned(u64::from(cell_width_px));
    encoder.unsigned(u64::from(cell_height_px));
    if protocol >= MODERN_PROTOCOL {
        encoder.boolean(false);
    }
    Ok(encoder.finish())
}

pub fn detach() -> Vec<u8> {
    vec![ClientMessageTag::Detach as u8]
}

pub fn attach(terminal_id: &str, takeover: bool) -> Vec<u8> {
    let mut encoder = Encoder::default();
    encoder.unsigned(ClientMessageTag::Attach as u64);
    encoder.byte_string(terminal_id.as_bytes());
    encoder.boolean(takeover);
    encoder.finish()
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the coordinate is finite, non-negative, rounded, and range-checked before conversion"
)]
fn scroll_coordinate(value: Option<f64>, name: &'static str) -> Result<Option<u16>, CodecError> {
    let Some(value) = value.filter(|value| value.is_finite()) else {
        return Ok(None);
    };
    let rounded = value.round().max(0.0);
    if rounded > f64::from(u16::MAX) {
        return Err(CodecError::InvalidValue(name));
    }
    Ok(Some(rounded as u16))
}

pub fn scroll(
    up: bool,
    lines: u32,
    column: Option<f64>,
    row: Option<f64>,
    modifiers: u8,
) -> Result<Vec<u8>, CodecError> {
    let lines = u16::try_from(lines).map_err(|_| CodecError::InvalidValue("scroll line count"))?;
    let column = scroll_coordinate(column, "scroll column")?;
    let row = scroll_coordinate(row, "scroll row")?;
    let mut encoder = Encoder::default();
    encoder.unsigned(ClientMessageTag::Scroll as u64);
    encoder.unsigned(AttachScrollSource::Wheel as u64);
    encoder.unsigned(if up {
        AttachScrollDirection::Up as u64
    } else {
        AttachScrollDirection::Down as u64
    });
    encoder.unsigned(u64::from(lines));
    match column {
        Some(value) => {
            encoder.boolean(true);
            encoder.unsigned(u64::from(value));
        }
        None => encoder.boolean(false),
    }
    match row {
        Some(value) => {
            encoder.boolean(true);
            encoder.unsigned(u64::from(value));
        }
        None => encoder.boolean(false),
    }
    encoder.bytes.push(modifiers);
    Ok(encoder.finish())
}

pub fn decode(bytes: &[u8], protocol: u32) -> Result<ServerMessage, CodecError> {
    validate_protocol(protocol)?;
    let mut decoder = Decoder::new(bytes);
    let variant = decoder.unsigned()?;
    if variant == SERVER_WELCOME {
        return Ok(ServerMessage::Welcome {
            protocol: decoder.u32("Welcome protocol")?,
            encoding: decoder.u32("Welcome encoding")?,
            error: decoder.option_string()?,
        });
    }
    if protocol >= MODERN_PROTOCOL {
        decode_modern_server_message(variant, &mut decoder)
    } else {
        decode_legacy_server_message(variant, protocol, &mut decoder)
    }
}

fn decode_legacy_server_message(
    variant: u64,
    protocol: u32,
    decoder: &mut Decoder<'_>,
) -> Result<ServerMessage, CodecError> {
    match variant {
        LEGACY_SERVER_TERMINAL => Ok(ServerMessage::Terminal {
            sequence: decoder.unsigned()?,
            width: decoder.u16("terminal frame width")?,
            height: decoder.u16("terminal frame height")?,
            full: decoder.boolean()?,
            bytes: decoder.owned_bytes()?,
        }),
        LEGACY_SERVER_GRAPHICS => Ok(ServerMessage::Graphics {
            bytes: decoder.owned_bytes()?,
        }),
        LEGACY_SERVER_CLOSED => Ok(ServerMessage::Closed {
            reason: decoder.option_string()?,
        }),
        LEGACY_SERVER_NOTIFY => Ok(ServerMessage::Notify {
            kind: HerdrTerminalNotificationKind::try_from(decoder.unsigned()?)?,
            text: decoder.string()?,
            body: decoder.option_string()?,
        }),
        LEGACY_SERVER_CLIPBOARD => Ok(ServerMessage::Clipboard {
            text: decoder.string()?,
        }),
        LEGACY_SERVER_TITLE => Ok(ServerMessage::Title {
            title: decoder.option_string()?,
        }),
        LEGACY_SERVER_RELOAD_SOUND_CONFIG => Ok(ServerMessage::ReloadSoundConfig),
        LEGACY_SERVER_MOUSE_CAPTURE => Ok(ServerMessage::MouseCapture {
            enabled: decoder.boolean()?,
        }),
        LEGACY_SERVER_PREFIX_INPUT_SOURCE_V17 if protocol == MIN_PROTOCOL => {
            Ok(ServerMessage::PrefixInputSource {
                enabled: decoder.boolean()?,
            })
        }
        LEGACY_SERVER_KITTY_KEYBOARD_REPORT_ALL => Ok(ServerMessage::KittyKeyboardReportAll {
            enabled: decoder.boolean()?,
        }),
        LEGACY_SERVER_PREFIX_INPUT_SOURCE if protocol > MIN_PROTOCOL => {
            Ok(ServerMessage::PrefixInputSource {
                enabled: decoder.boolean()?,
            })
        }
        LEGACY_SERVER_TERMINAL_BELL if protocol >= 20 => {
            let count = decoder.unsigned()?;
            Ok(ServerMessage::TerminalBell {
                count: u16::try_from(count).map_err(|_| CodecError::InvalidBellCount(count))?,
            })
        }
        _ => Ok(ServerMessage::Ignored { variant }),
    }
}

fn decode_modern_server_message(
    variant: u64,
    decoder: &mut Decoder<'_>,
) -> Result<ServerMessage, CodecError> {
    match variant {
        MODERN_SERVER_TERMINAL => Ok(ServerMessage::Terminal {
            sequence: decoder.unsigned()?,
            width: decoder.u16("terminal frame width")?,
            height: decoder.u16("terminal frame height")?,
            full: decoder.boolean()?,
            bytes: decoder.owned_bytes()?,
        }),
        MODERN_SERVER_GRAPHICS => Ok(ServerMessage::Graphics {
            bytes: decoder.owned_bytes()?,
        }),
        MODERN_SERVER_CLOSED => Ok(ServerMessage::Closed {
            reason: decoder.option_string()?,
        }),
        MODERN_SERVER_NOTIFY => Ok(ServerMessage::Notify {
            kind: HerdrTerminalNotificationKind::try_from(decoder.unsigned()?)?,
            text: decoder.string()?,
            body: decoder.option_string()?,
        }),
        MODERN_SERVER_CLIPBOARD => Ok(ServerMessage::Clipboard {
            text: decoder.string()?,
        }),
        MODERN_SERVER_TITLE => Ok(ServerMessage::Title {
            title: decoder.option_string()?,
        }),
        MODERN_SERVER_RELOAD_SOUND_CONFIG => Ok(ServerMessage::ReloadSoundConfig),
        MODERN_SERVER_MOUSE_CAPTURE => {
            let enabled = decoder.boolean()?;
            let _sgr_pixels = decoder.boolean()?;
            Ok(ServerMessage::MouseCapture { enabled })
        }
        MODERN_SERVER_TERMINAL_BELL => {
            let count = decoder.unsigned()?;
            Ok(ServerMessage::TerminalBell {
                count: u16::try_from(count).map_err(|_| CodecError::InvalidBellCount(count))?,
            })
        }
        MODERN_SERVER_DIRECT_TERMINAL_KEYBOARD_PROTOCOL => {
            let flags = decoder.u16("direct terminal keyboard flags")?;
            let _modify_other_keys_level = decoder.byte("modifyOtherKeys level")?;
            Ok(ServerMessage::KittyKeyboardReportAll {
                enabled: flags & KITTY_FLAG_REPORT_ALL_KEYS != 0,
            })
        }
        _ => Ok(ServerMessage::Ignored { variant }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_matches_legacy_and_modern_wire_fixtures() {
        for protocol in [MIN_PROTOCOL, MODERN_PROTOCOL - 1] {
            assert_eq!(
                hello(
                    protocol,
                    80,
                    24,
                    8,
                    16,
                    HerdrTerminalAttachLaunchMode::LegacyTerminalAttach,
                )
                .unwrap(),
                vec![0, u8::try_from(protocol).unwrap(), 80, 24, 8, 16, 1, 0, 1]
            );
            assert_eq!(
                hello(
                    protocol,
                    80,
                    24,
                    8,
                    16,
                    HerdrTerminalAttachLaunchMode::TerminalAttach,
                )
                .unwrap(),
                vec![0, u8::try_from(protocol).unwrap(), 80, 24, 8, 16, 1, 0, 2]
            );
        }
        for launch_mode in [
            HerdrTerminalAttachLaunchMode::LegacyTerminalAttach,
            HerdrTerminalAttachLaunchMode::TerminalAttach,
        ] {
            let modern_protocol = u8::try_from(MODERN_PROTOCOL).unwrap();
            assert_eq!(
                hello(MAX_PROTOCOL, 80, 24, 8, 16, launch_mode).unwrap(),
                vec![0, modern_protocol, 80, 24, 8, 16, 0]
            );
        }
    }

    #[test]
    fn terminal_attach_launch_mode_follows_protocol() {
        assert_eq!(
            HerdrTerminalAttachLaunchMode::for_protocol(19),
            HerdrTerminalAttachLaunchMode::LegacyTerminalAttach
        );
        assert_eq!(
            HerdrTerminalAttachLaunchMode::for_protocol(20),
            HerdrTerminalAttachLaunchMode::TerminalAttach
        );
    }

    #[test]
    fn client_messages_match_js_fixtures() {
        assert_eq!(input(b"hi"), vec![1, 2, 104, 105]);
        assert_eq!(
            resize(MODERN_PROTOCOL - 1, 80, 24, 8, 16).unwrap(),
            vec![3, 80, 24, 8, 16]
        );
        assert_eq!(
            resize(MODERN_PROTOCOL, 80, 24, 8, 16).unwrap(),
            vec![3, 80, 24, 8, 16, 0]
        );
        assert_eq!(detach(), vec![4]);
        assert_eq!(attach("t1", true), vec![5, 2, 116, 49, 1]);
        assert_eq!(attach("t1", false), vec![5, 2, 116, 49, 0]);
        assert_eq!(
            scroll(true, 3, None, None, 0).unwrap(),
            vec![6, 0, 0, 3, 0, 0, 0]
        );
        assert_eq!(
            scroll(false, 4, Some(12.0), Some(7.0), 0).unwrap(),
            vec![6, 0, 1, 4, 1, 12, 1, 7, 0]
        );
        assert_eq!(
            scroll(true, 2, Some(-4.5), Some(3.6), 5).unwrap(),
            vec![6, 0, 0, 2, 1, 0, 1, 4, 5]
        );
    }

    #[test]
    fn welcome_and_welcome_error_decode() {
        assert_eq!(
            decode(&[0, 20, 1, 0], 20).unwrap(),
            ServerMessage::Welcome {
                protocol: 20,
                encoding: 1,
                error: None,
            }
        );
        assert_eq!(
            decode(&[0, 20, 1, 1, 3, b'b', b'a', b'd'], 20).unwrap(),
            ServerMessage::Welcome {
                protocol: 20,
                encoding: 1,
                error: Some("bad".to_owned()),
            }
        );
        assert_eq!(
            decode(
                &[0, u8::try_from(MODERN_PROTOCOL).unwrap(), 1, 0],
                MODERN_PROTOCOL,
            )
            .unwrap(),
            ServerMessage::Welcome {
                protocol: MODERN_PROTOCOL,
                encoding: 1,
                error: None,
            }
        );
    }

    #[test]
    fn terminal_frame_preserves_arbitrary_binary_bytes() {
        let expected = ServerMessage::Terminal {
            sequence: 42,
            width: 80,
            height: 24,
            full: true,
            bytes: vec![0, 0xff, 0x80, 0x1b],
        };
        assert_eq!(
            decode(&[2, 42, 80, 24, 1, 4, 0, 0xff, 0x80, 0x1b], 20).unwrap(),
            expected
        );
        assert_eq!(
            decode(&[1, 42, 80, 24, 1, 4, 0, 0xff, 0x80, 0x1b], MODERN_PROTOCOL).unwrap(),
            expected
        );
    }

    #[test]
    fn protocol_specific_variants_decode() {
        assert_eq!(
            decode(&[10, 1], 17).unwrap(),
            ServerMessage::PrefixInputSource { enabled: true }
        );
        assert_eq!(
            decode(&[10, 1], 18).unwrap(),
            ServerMessage::KittyKeyboardReportAll { enabled: true }
        );
        assert_eq!(
            decode(&[11, 0], 18).unwrap(),
            ServerMessage::PrefixInputSource { enabled: false }
        );
        assert_eq!(
            decode(&[11, 1], 17).unwrap(),
            ServerMessage::Ignored { variant: 11 }
        );
    }

    #[test]
    fn all_control_and_graphics_messages_decode() {
        assert_eq!(
            decode(&[3, 3, 0, 0xff, 1], 20).unwrap(),
            ServerMessage::Graphics {
                bytes: vec![0, 0xff, 1]
            }
        );
        assert_eq!(
            decode(&[4, 1, 3, b'b', b'y', b'e'], 20).unwrap(),
            ServerMessage::Closed {
                reason: Some("bye".to_owned())
            }
        );
        assert_eq!(
            decode(
                &[
                    5, 2, 4, b'd', b'o', b'n', b'e', 1, 4, b'b', b'o', b'd', b'y'
                ],
                20
            )
            .unwrap(),
            ServerMessage::Notify {
                kind: HerdrTerminalNotificationKind::SystemToast,
                text: "done".to_owned(),
                body: Some("body".to_owned()),
            }
        );
        assert_eq!(
            decode(&[6, 3, b'a', b'b', b'c'], 20).unwrap(),
            ServerMessage::Clipboard {
                text: "abc".to_owned()
            }
        );
        assert_eq!(
            decode(&[7, 0], 20).unwrap(),
            ServerMessage::Title { title: None }
        );
        assert_eq!(decode(&[8], 20).unwrap(), ServerMessage::ReloadSoundConfig);
        assert_eq!(
            decode(&[9, 1], 20).unwrap(),
            ServerMessage::MouseCapture { enabled: true }
        );
    }

    #[test]
    fn modern_control_and_graphics_messages_decode() {
        assert_eq!(
            decode(&[2, 3, 0, 0xff, 1], MODERN_PROTOCOL).unwrap(),
            ServerMessage::Graphics {
                bytes: vec![0, 0xff, 1]
            }
        );
        assert_eq!(
            decode(&[3, 1, 3, b'b', b'y', b'e'], MODERN_PROTOCOL).unwrap(),
            ServerMessage::Closed {
                reason: Some("bye".to_owned())
            }
        );
        assert_eq!(
            decode(
                &[
                    4, 2, 4, b'd', b'o', b'n', b'e', 1, 4, b'b', b'o', b'd', b'y'
                ],
                MODERN_PROTOCOL,
            )
            .unwrap(),
            ServerMessage::Notify {
                kind: HerdrTerminalNotificationKind::SystemToast,
                text: "done".to_owned(),
                body: Some("body".to_owned()),
            }
        );
        assert_eq!(
            decode(&[5, 3, b'a', b'b', b'c'], MODERN_PROTOCOL).unwrap(),
            ServerMessage::Clipboard {
                text: "abc".to_owned()
            }
        );
        assert_eq!(
            decode(&[6, 0], MODERN_PROTOCOL).unwrap(),
            ServerMessage::Title { title: None }
        );
        assert_eq!(
            decode(&[7], MODERN_PROTOCOL).unwrap(),
            ServerMessage::ReloadSoundConfig
        );
        assert_eq!(
            decode(&[8, 1, 1], MODERN_PROTOCOL).unwrap(),
            ServerMessage::MouseCapture { enabled: true }
        );
    }

    #[test]
    fn keyboard_protocol_controls_preserve_report_all_state() {
        assert_eq!(
            decode(&[16, 8, 0], MODERN_PROTOCOL).unwrap(),
            ServerMessage::KittyKeyboardReportAll { enabled: true }
        );
        assert_eq!(
            decode(&[16, 3, 2], MODERN_PROTOCOL).unwrap(),
            ServerMessage::KittyKeyboardReportAll { enabled: false }
        );
    }

    #[test]
    fn terminal_bell_follows_each_wire_layout() {
        assert_eq!(
            decode(&[12, 3], 20).unwrap(),
            ServerMessage::TerminalBell { count: 3 }
        );
        assert_eq!(
            decode(&[12, 3], 19).unwrap(),
            ServerMessage::Ignored { variant: 12 }
        );
        assert_eq!(
            decode(&[12, 252, 0, 0, 1, 0], 20),
            Err(CodecError::InvalidBellCount(65_536))
        );
        assert_eq!(
            decode(&[9, 3], MODERN_PROTOCOL).unwrap(),
            ServerMessage::TerminalBell { count: 3 }
        );
    }

    #[test]
    fn malformed_and_truncated_frames_return_errors() {
        assert!(matches!(decode(&[], 20), Err(CodecError::Truncated(_))));
        assert!(matches!(
            decode(&[2, 42, 80], 20),
            Err(CodecError::Truncated(_))
        ));
        assert_eq!(decode(&[9, 2], 20), Err(CodecError::InvalidBoolean(2)));
        assert_eq!(
            decode(&[0, 20, 1, 2], 20),
            Err(CodecError::InvalidOptionTag(2))
        );
        assert_eq!(
            decode(&[5, 3], 20),
            Err(CodecError::InvalidNotificationKind(3))
        );
        assert_eq!(
            decode(&[254], 20),
            Err(CodecError::InvalidIntegerMarker(254))
        );
        assert_eq!(
            decode(&[253, 0, 0, 0, 0, 0, 0, 0x20, 0], 20),
            Err(CodecError::IntegerOverflow)
        );
    }

    #[test]
    fn invalid_and_oversized_client_values_return_errors() {
        assert!(matches!(
            hello(
                16,
                80,
                24,
                8,
                16,
                HerdrTerminalAttachLaunchMode::LegacyTerminalAttach,
            ),
            Err(CodecError::UnsupportedProtocol(16))
        ));
        assert_eq!(
            HerdrTerminalAttachLaunchMode::try_from(3),
            Err(CodecError::UnsupportedLaunchMode(3))
        );
        assert!(resize(MIN_PROTOCOL, u32::from(u16::MAX) + 1, 24, 0, 0).is_err());
        assert!(scroll(true, u32::from(u16::MAX) + 1, None, None, 0).is_err());
        assert!(scroll(true, 1, Some(70_000.0), None, 0).is_err());
    }
}
