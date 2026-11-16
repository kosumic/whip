//! Execute both argument layers, rather than asserting a quoting spelling.
#![cfg(unix)]
use herdr_protocol::hc::endpoint::{posix_command, shell_quote};
use std::process::Command;

#[test]
fn posix_arguments_round_trip_without_changing_command_structure() -> std::io::Result<()> {
    for value in [
        "",
        "plain",
        "space separated",
        "'",
        "\\",
        "\\\\'",
        "line\nnext\r\t\u{1}",
        "日本語 café",
        "$HOME",
        "`printf injected`",
        "$(printf injected)",
        "'; printf injected; #",
        "\"; printf injected; #",
    ] {
        let script = format!("printf '%s' {}", shell_quote(value));
        for shell in ["sh", "bash"] {
            for command in [&script, &posix_command(&script)] {
                let output = Command::new(shell).args(["-c", command]).output()?;
                assert!(output.status.success(), "{shell}: {:?}", output.stderr);
                assert!(output.stderr.is_empty());
                assert_eq!(output.stdout, value.as_bytes(), "{shell}: {value:?}");
            }
        }
    }
    Ok(())
}
