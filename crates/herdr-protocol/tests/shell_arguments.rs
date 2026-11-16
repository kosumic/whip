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

#[test]
fn nested_posix_apostrophes_survive_a_fish_login_shell() -> std::io::Result<()> {
    if !Command::new("fish")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success())
    {
        return Ok(());
    }
    // Remote Git commands enter through the SSH login shell before sh -c.
    // Keep the mobile apostrophe encoding; POSIX's alternative '\'' encoding
    // changes command structure when nested through Fish.
    let value = "file space'$HOME.txt";
    let script = format!("printf '%s' {}", shell_quote(value));
    let output = Command::new("fish")
        .args(["-c", &posix_command(&script)])
        .output()?;
    assert!(output.status.success(), "{:?}", output.stderr);
    assert_eq!(output.stdout, value.as_bytes());
    Ok(())
}
