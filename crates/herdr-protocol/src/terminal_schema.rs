//! Canonical Rust types, shared with Whip's remote FFI declarations.
#[doc(hidden)]
#[macro_export]
macro_rules! herdr_terminal_type_schema {
    ($apply:ident) => {
        $apply!(
            Enum,
            /// Protocol 20 moved terminal attach from discriminant 1 to 2.
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum HerdrTerminalAttachLaunchMode {
                LegacyTerminalAttach,
                TerminalAttach,
            }
        );
        $apply!(
            Enum,
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum HerdrTerminalNotificationKind {
                Sound,
                Toast,
                SystemToast,
            }
        );
    };
}
