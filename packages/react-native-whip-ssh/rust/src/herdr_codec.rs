//! Native registrations for the shared Herdr terminal codec.
pub use herdr_protocol::terminal::{
    CodecError, HerdrTerminalAttachLaunchMode, HerdrTerminalEncoding,
    HerdrTerminalNotificationKind, MAX_FRAME_BYTES, MAX_PROTOCOL, MIN_PROTOCOL, ScrollDirection,
    ServerMessage, attach, decode, detach, endpoint_control, hello, input, resize, scroll,
    validate_protocol,
};
macro_rules! native_type {
    ($kind:ident, $item:item) => {
        #[uniffi::remote($kind)]
        $item
    };
}
herdr_protocol::herdr_terminal_type_schema!(native_type);
