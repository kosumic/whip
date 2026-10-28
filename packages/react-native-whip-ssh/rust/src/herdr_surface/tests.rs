use super::*;
use crate::herdr_codec::{Decoder, Encoder};

fn cell(e: &mut Encoder, symbol: &str) {
    e.byte_string(symbol.as_bytes());
    e.unsigned(0x02010203);
    e.unsigned(0x010000fa);
    e.unsigned(1 | 4 | 8 | 64);
    e.boolean(false);
    e.boolean(true);
    e.unsigned(0);
}
fn rect(e: &mut Encoder, width: u16, height: u16) {
    e.unsigned(0);
    e.unsigned(0);
    e.unsigned(width.into());
    e.unsigned(height.into());
}
fn panes(e: &mut Encoder, width: u16, height: u16, scrollbar: bool) {
    e.unsigned(1);
    e.byte_string(b"pane");
    e.unsigned(1);
    rect(e, width, height);
    rect(e, width - u16::from(scrollbar), height);
    e.boolean(scrollbar);
    if scrollbar {
        e.unsigned(u64::from(width - 1));
        e.unsigned(0);
        e.unsigned(1);
        e.unsigned(u64::from(height));
    }
    e.boolean(false);
    e.boolean(true);
    e.boolean(false);
    e.boolean(false);
    e.boolean(false);
    e.unsigned(0);
    e.unsigned(0);
}
fn full(width: u16, height: u16, revision: u64) -> Vec<u8> {
    full_geometry(width, height, revision, false)
}
fn full_geometry(width: u16, height: u16, revision: u64, scrollbar: bool) -> Vec<u8> {
    let mut e = Encoder::default();
    e.unsigned(13);
    e.byte_string(b"boot");
    e.unsigned(1);
    e.unsigned(revision);
    e.unsigned(u64::from(width) * u64::from(height));
    let symbols = ["e\u{301}", "界", "", "👩🏽‍💻", "", " "];
    for i in 0..u32::from(width) * u32::from(height) {
        cell(&mut e, symbols[i as usize % symbols.len()]);
    }
    e.unsigned(width.into());
    e.unsigned(height.into());
    e.boolean(true);
    e.unsigned(0);
    e.unsigned(0);
    e.boolean(true);
    e.raw(&[6]);
    e.unsigned(1);
    e.byte_string(b"https://example.test");
    e.unsigned(0);
    panes(&mut e, width, height, scrollbar);
    e.unsigned(0);
    e.boolean(false);
    e.unsigned(0);
    e.unsigned(0);
    e.unsigned(0);
    e.finish()
}
fn patch(base: u64, revision: u64, x: u16, y: u16, symbol: &str) -> Vec<u8> {
    patch_geometry(base, revision, x, y, symbol, None)
}
fn patch_geometry(
    base: u64,
    revision: u64,
    x: u16,
    y: u16,
    symbol: &str,
    geometry: Option<(u16, u16, bool)>,
) -> Vec<u8> {
    let mut e = Encoder::default();
    e.unsigned(19);
    e.byte_string(b"boot");
    e.unsigned(1);
    e.unsigned(base);
    e.unsigned(revision);
    e.unsigned(1);
    e.unsigned(x.into());
    e.unsigned(y.into());
    e.unsigned(1);
    cell(&mut e, symbol);
    if let Some((width, height, scrollbar)) = geometry {
        panes(&mut e, width, height, scrollbar);
    } else {
        e.unsigned(0);
    }
    e.boolean(false);
    e.finish()
}
fn apply(screen: &mut model::Screen, bytes: &[u8]) -> Result<(), herdr_codec::CodecError> {
    screen.apply(model::decode(bytes)?, "pane", "boot", 1)
}
fn update(screen: &mut model::Screen) -> serde_json::Value {
    serde_json::from_str(&screen.take().unwrap().unwrap()).unwrap()
}

#[test]
fn endpoint_hello_uses_generation_one_and_only_required_codecs() {
    let bytes = hello(80, 24, 9, 18);
    assert_eq!(bytes[0], 20);
    let mut d = Decoder::new(&bytes);
    assert_eq!(d.unsigned().unwrap(), 20);
    assert_eq!(d.strict_string(100).unwrap(), "endpoint.hello.v1");
    let value: serde_json::Value = serde_json::from_str(&d.strict_string(8192).unwrap()).unwrap();
    assert_eq!(value["generation"], 1);
    assert_eq!(value["surface_active"], true);
    assert_eq!(value["endpoint_keybindings"], false);
    assert_eq!(value["direct_graphics"], false);
    for (key, codec) in [
        ("snapshot_codecs", SNAPSHOT),
        ("surface_codecs", SURFACE),
        ("input_codecs", INPUT),
        ("blob_codecs", BLOB),
    ] {
        assert_eq!(value[key], serde_json::json!([codec]));
    }
    assert!(value.get("surface_delta").is_none());
    assert!(d.exhausted());
}
#[test]
fn welcome_accepts_future_optional_fields_but_rejects_codec_mismatch() {
    let mut welcome = serde_json::json!({"generation":1,"snapshot_codec":SNAPSHOT,"surface_codec":SURFACE,"input_codec":INPUT,"blob_codec":BLOB,"future":true,"error":null});
    assert!(validate_welcome(&welcome.to_string()).is_ok());
    welcome["generation"] = 2.into();
    assert!(validate_welcome(&welcome.to_string()).is_err());
    welcome["generation"] = 1.into();
    welcome["surface_codec"] = "unknown".into();
    assert!(validate_welcome(&welcome.to_string()).is_err());
}
#[test]
fn full_frame_preserves_graphemes_colors_links_and_cursor() {
    let mut screen = model::Screen::default();
    apply(&mut screen, &full(6, 2, 1)).unwrap();
    let view = update(&mut screen);
    assert_eq!(view["width"], 6);
    assert_eq!(view["height"], 2);
    assert_eq!(view["reset"], true);
    assert_eq!(view["rows"][0][2][0]["symbol"], "e\u{301}");
    assert_eq!(view["rows"][0][2][1]["symbol"], "界");
    assert_eq!(view["rows"][0][2][2]["symbol"], "");
    assert_eq!(view["rows"][0][2][3]["symbol"], "👩🏽‍💻");
    assert_eq!(view["rows"][0][2][0]["fg"], 0x02010203u32);
    assert_eq!(view["rows"][0][2][0]["bg"], 0x010000fau32);
    assert_eq!(view["rows"][0][2][0]["modifier"], 77);
    assert_eq!(view["rows"][0][2][0]["hyperlink"], 0);
    assert_eq!(view["hyperlinks"][0], "https://example.test");
    assert_eq!(view["cursor"]["shape"], 6);
    assert!(screen.take().unwrap().is_none());
}
#[test]
fn patches_coalesce_dirty_rows_and_do_not_reserialize_unchanged_rows() {
    let mut screen = model::Screen::default();
    apply(&mut screen, &full(80, 24, 1)).unwrap();
    update(&mut screen);
    apply(&mut screen, &patch(1, 2, 1, 3, "a")).unwrap();
    apply(&mut screen, &patch(2, 3, 2, 3, "b")).unwrap();
    let view = update(&mut screen);
    assert_eq!(view["revision"], 3);
    assert_eq!(view["reset"], false);
    assert_eq!(view["rows"].as_array().unwrap().len(), 1);
    assert_eq!(view["rows"][0][0], 3);
    assert_eq!(view["rows"][0][2][1]["symbol"], "a");
    assert_eq!(view["rows"][0][2][2]["symbol"], "b");
    assert!(view["cursor"].is_null());
}

#[test]
fn identical_full_frames_advance_revisions_without_redrawing() {
    let mut screen = model::Screen::default();
    apply(&mut screen, &full(80, 24, 1)).unwrap();
    update(&mut screen);
    apply(&mut screen, &full(80, 24, 2)).unwrap();
    assert!(screen.take().unwrap().is_none());
    apply(&mut screen, &patch(2, 3, 40, 7, "changed")).unwrap();
    let view = update(&mut screen);
    assert_eq!(view["revision"], 3);
    assert_eq!(view["reset"], false);
    assert_eq!(view["rows"].as_array().unwrap().len(), 1);
    let span = &view["rows"][0];
    assert_eq!(span[0], 7);
    let start = span[1].as_u64().unwrap() as usize;
    assert!(start <= 40);
    assert!(span[2].as_array().unwrap().len() < 8);
    assert_eq!(span[2][40 - start]["symbol"], "changed");
    apply(&mut screen, &patch(3, 4, 40, 7, "changed")).unwrap();
    assert!(screen.take().unwrap().is_none());
    apply(&mut screen, &patch(4, 5, 41, 7, "next")).unwrap();
    assert_eq!(update(&mut screen)["revision"], 5);
}

#[test]
fn identical_cells_and_cursor_changes_do_not_damage_text() {
    let mut screen = model::Screen::default();
    apply(&mut screen, &full(6, 2, 1)).unwrap();
    update(&mut screen);
    // The patch removes the cursor, but repeats the existing grapheme exactly.
    apply(&mut screen, &patch(1, 2, 0, 0, "e\u{301}")).unwrap();
    let view = update(&mut screen);
    assert!(view["rows"].as_array().unwrap().is_empty());
    assert!(view["cursor"].is_null());
    apply(&mut screen, &patch(2, 3, 0, 0, "e\u{301}")).unwrap();
    assert!(screen.take().unwrap().is_none());
}

#[test]
fn damage_includes_wide_graphemes_and_keeps_pending_spans_until_drained() {
    let mut screen = model::Screen::default();
    apply(&mut screen, &full(6, 2, 1)).unwrap();
    update(&mut screen);
    apply(&mut screen, &patch(1, 2, 2, 0, "x")).unwrap();
    let view = update(&mut screen);
    assert_eq!(view["rows"][0][1], 1);
    assert_eq!(view["rows"][0][2][0]["symbol"], "界");
    assert_eq!(view["rows"][0][2][3]["symbol"], "");

    apply(&mut screen, &patch(2, 3, 0, 1, "a")).unwrap();
    // A full frame received before drain must preserve pending damage in row one.
    apply(&mut screen, &full(6, 2, 4)).unwrap();
    let view = update(&mut screen);
    assert_eq!(view["reset"], false);
    assert_eq!(view["rows"].as_array().unwrap().len(), 2);
    assert_eq!(view["rows"][1][0], 1);
}
#[test]
fn revision_gaps_out_of_order_and_malformed_patches_are_atomic() {
    let mut screen = model::Screen::default();
    apply(&mut screen, &full(6, 2, 1)).unwrap();
    update(&mut screen);
    for bytes in [
        patch(2, 3, 0, 0, "a"),
        patch(1, 3, 0, 0, "a"),
        patch(1, 1, 0, 0, "a"),
        patch(1, 2, 6, 0, "a"),
        patch(1, 2, 0, 2, "a"),
        full(6, 2, 1),
    ] {
        assert!(apply(&mut screen, &bytes).is_err());
        assert!(screen.take().unwrap().is_none());
    }
    apply(&mut screen, &patch(1, 2, 0, 0, "ok")).unwrap();
    assert_eq!(update(&mut screen)["revision"], 2);
}
#[test]
fn resize_requires_a_new_full_frame() {
    let mut screen = model::Screen::default();
    apply(&mut screen, &full(6, 2, 1)).unwrap();
    update(&mut screen);
    apply(&mut screen, &full(8, 3, 2)).unwrap();
    let view = update(&mut screen);
    assert_eq!(view["reset"], true);
    assert_eq!(view["width"], 8);
    assert_eq!(view["rows"].as_array().unwrap().len(), 3);
}
#[test]
fn decoder_rejects_truncation_trailing_bytes_and_unbounded_collections() {
    let valid = full(6, 2, 1);
    for end in 0..valid.len() {
        assert!(model::decode(&valid[..end]).is_err());
    }
    let mut trailing = valid;
    trailing.push(0);
    assert!(model::decode(&trailing).is_err());
    let mut e = Encoder::default();
    e.unsigned(13);
    e.byte_string(b"boot");
    e.unsigned(1);
    e.unsigned(1);
    e.unsigned(u64::MAX);
    assert!(model::decode(&e.finish()).is_err());
    assert!(model::dimensions(0, 80).is_err());
    assert!(model::dimensions(1024, 1024).is_err());
}
#[test]
fn stale_callbacks_after_detach_and_session_replacement_are_ignored() {
    let connection = HerdrConnection::new("test".into(), "test".into(), None, None);
    let surface = HerdrSurface {
        connection,
        pane_id: "pane".into(),
        state: Mutex::new(State {
            epoch: 2,
            ..State::default()
        }),
    };
    surface.frame(1, &[255]);
    assert!(surface.state.lock().error.is_none());
    surface.close();
    surface.frame(2, &[255]);
    assert_eq!(
        surface.state.lock().error.as_deref(),
        Some("surface detached")
    );
    // A new channel starts with no old screen or revisions.
    *surface.state.lock() = State {
        epoch: 4,
        ..State::default()
    };
    surface.frame(3, &[255]);
    assert!(surface.state.lock().error.is_none());
    surface.frame(4, &full(6, 2, 1));
    assert!(
        surface
            .state
            .lock()
            .error
            .as_ref()
            .unwrap()
            .contains("before endpoint snapshot")
    );
}
#[test]
fn input_is_semantic_and_never_raw_ansi() {
    // Frozen Endpoint v1 binary fixtures: pane input tag, target, event count, event.
    assert_eq!(
        input::encode("p", "界", false).unwrap(),
        [vec![13, 1, b'p', 1, 1, 3], "界".as_bytes().to_vec()].concat()
    );
    assert_eq!(
        input::encode("p", "abc\n", true).unwrap(),
        vec![13, 1, b'p', 1, 3, 4, b'a', b'b', b'c', b'\n']
    );
    for (text, code, modifiers) in [
        ("\r", 1, 0),
        ("\x7f", 0, 0),
        ("\x1b", 14, 0),
        ("\t", 10, 0),
        ("\x1b[A", 4, 0),
        ("\x1b[1;5D", 2, 2),
        ("\x1b[1;3D", 2, 4),
        ("\x1b[1;8D", 2, 7),
        ("\x1b[3~", 12, 0),
    ] {
        let bytes = input::encode("p", text, false).unwrap();
        assert_eq!(
            bytes,
            vec![13, 1, b'p', 1, 0, code, modifiers, 0, 1, 0, 0, 0, 0, 0]
        );
    }
    let ctrl = input::encode("p", "\x03", false).unwrap();
    assert_eq!(&ctrl[4..8], &[0, 15, b'c', 2]);
    let kill_line = input::encode("p", "\x15", false).unwrap();
    assert_eq!(&kill_line[4..8], &[0, 15, b'u', 2]);
    let alt = input::encode("p", "\x1bx", false).unwrap();
    assert_eq!(&alt[4..8], &[0, 15, b'x', 4]);
    assert!(input::encode("p", "\x1b[999~", false).is_err());
}

#[test]
#[ignore = "manual model microbenchmark, not a device renderer benchmark"]
fn benchmark_surface_model() {
    let mut screen = model::Screen::default();
    let bytes = full(80, 24, 1);
    let (_, full_ns, full_alloc, full_bytes, full_peak) =
        crate::test_allocations::measured_with_peak(|| {
            apply(&mut screen, &bytes).unwrap();
            screen.take().unwrap().unwrap().len()
        });
    let iterations = 1000;
    let mut patch_bytes = 0;
    let mut bridge_bytes = 0;
    let (_, ns, alloc, bytes, peak) = crate::test_allocations::measured_with_peak(|| {
        for i in 1..=iterations {
            let bytes = patch(i, i + 1, 0, 0, if i % 2 == 0 { "x" } else { "y" });
            patch_bytes += bytes.len();
            apply(&mut screen, &bytes).unwrap();
            bridge_bytes += screen.take().unwrap().unwrap().len();
        }
    });
    println!(
        "80x24 debug host: full decode/apply/drain ns={full_ns}, allocations={full_alloc}, allocated_bytes={full_bytes}, peak_bytes={full_peak}; {iterations} one-cell patches ns={ns}, allocations={alloc}, allocated_bytes={bytes}, peak_bytes={peak}, wire_bytes={patch_bytes}, bridge_bytes={bridge_bytes}"
    );
}

#[cfg(unix)]
#[test]
#[ignore = "requires an installed Herdr binary; uses only an isolated temporary server"]
fn live_isolated_endpoint_roundtrip() {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::process::{Command, Stdio};
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("herdr.sock");
    let client = directory.path().join("herdr-client.sock");
    let config = directory.path().join("config.toml");
    std::fs::write(&config, "onboarding = false\n").unwrap();
    let log = std::fs::File::create(directory.path().join("server.log")).unwrap();
    let _server = Server(
        Command::new("herdr")
            .arg("server")
            .env("HERDR_SOCKET_PATH", &socket)
            .env("HERDR_CLIENT_SOCKET_PATH", &client)
            .env("HERDR_CONFIG_PATH", &config)
            .env("XDG_CONFIG_HOME", directory.path())
            .env("XDG_RUNTIME_DIR", directory.path())
            .env("SHELL", "/bin/sh")
            .env_remove("HERDR_ENV")
            .env_remove("HERDR_SESSION")
            .env_remove("HERDR_STARTUP_CWD")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !client.exists() {
        assert!(
            Instant::now() < deadline,
            "server socket missing: {}",
            std::fs::read_to_string(directory.path().join("server.log")).unwrap()
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    fn send(socket: &mut UnixStream, bytes: &[u8]) {
        socket
            .write_all(&u32::try_from(bytes.len()).unwrap().to_le_bytes())
            .unwrap();
        socket.write_all(bytes).unwrap();
    }
    fn read(socket: &mut UnixStream) -> Vec<u8> {
        let mut len = [0; 4];
        socket.read_exact(&mut len).unwrap();
        let len = u32::from_le_bytes(len) as usize;
        assert!(len <= MAX_SURFACE_BYTES);
        let mut bytes = vec![0; len];
        socket.read_exact(&mut bytes).unwrap();
        bytes
    }
    fn receive(
        socket: &mut UnixStream,
        screen: &mut model::Screen,
        boot: &mut String,
        projection: &mut u64,
        pane: &mut String,
    ) -> bool {
        let bytes = read(socket);
        match model::decode(&bytes).unwrap() {
            model::SurfaceMessage::Other => {
                if let ServerMessage::EndpointControl { kind, data } =
                    herdr_codec::decode(&bytes, 22).unwrap()
                {
                    if kind == WELCOME {
                        validate_welcome(&data).unwrap();
                    }
                    if kind == SNAPSHOT {
                        let s: Snapshot = serde_json::from_str(&data).unwrap();
                        *boot = s.boot_id;
                        *projection = s.revision;
                        *pane = s.focused_pane_id.unwrap();
                    }
                }
                false
            }
            message => {
                screen.apply(message, pane, boot, *projection).unwrap();
                true
            }
        }
    }
    let mut socket = UnixStream::connect(&client).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    send(&mut socket, &hello(80, 24, 8, 16));
    let mut screen = model::Screen::default();
    let mut boot = String::new();
    let mut projection = 0;
    let mut pane = String::new();
    while !receive(
        &mut socket,
        &mut screen,
        &mut boot,
        &mut projection,
        &mut pane,
    ) {}
    let initial = update(&mut screen);
    assert_eq!(initial["width"], 80);
    let mut command = input::encode(
        &pane,
        "printf '\\033[31mWHIP_ENDPOINT_OK\\033[0m界é\\n'",
        true,
    )
    .unwrap();
    send(&mut socket, &command);
    command = input::encode(&pane, "\r", false).unwrap();
    send(&mut socket, &command);
    let mut found = false;
    for _ in 0..100 {
        if receive(
            &mut socket,
            &mut screen,
            &mut boot,
            &mut projection,
            &mut pane,
        ) {
            let view = update(&mut screen);
            let text = view["rows"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|row| row[2].as_array().unwrap())
                .map(|cell| cell["symbol"].as_str().unwrap())
                .collect::<String>();
            // Command echo also includes the marker; a colored cell proves execution.
            let colored = view["rows"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|row| row[2].as_array().unwrap())
                .any(|c| c["symbol"] == "W" && c["fg"] != 0);
            if text.contains("WHIP_ENDPOINT_OK") && colored {
                found = true;
                break;
            }
        }
    }
    assert!(found, "semantic input did not yield rendered output");
    let mut e = Encoder::default();
    e.unsigned(12);
    e.unsigned(8);
    e.unsigned(16);
    e.unsigned(90);
    e.unsigned(30);
    e.boolean(false);
    send(&mut socket, &e.finish());
    loop {
        if receive(
            &mut socket,
            &mut screen,
            &mut boot,
            &mut projection,
            &mut pane,
        ) && update(&mut screen)["width"] == 90
        {
            break;
        }
    }
    send(&mut socket, &herdr_codec::detach());
    drop(socket);
    let previous_pane = pane.clone();
    let mut socket = UnixStream::connect(&client).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    send(&mut socket, &hello(80, 24, 8, 16));
    screen = model::Screen::default();
    boot.clear();
    projection = 0;
    pane.clear();
    while !receive(
        &mut socket,
        &mut screen,
        &mut boot,
        &mut projection,
        &mut pane,
    ) {}
    assert_eq!(pane, previous_pane);
    assert_eq!(update(&mut screen)["reset"], true);
    send(&mut socket, &herdr_codec::detach());
    println!(
        "Live isolated Herdr: Endpoint v1 full frame, semantic paste/Enter, colored Unicode output, patch application, resize and reconnect passed"
    );
}

#[test]
fn scrollbar_patches_follow_endpoint_geometry_rules() {
    let mut screen = model::Screen::default();
    apply(&mut screen, &full_geometry(4, 2, 1, true)).unwrap();
    screen.take().unwrap();
    apply(
        &mut screen,
        &patch_geometry(1, 2, 3, 1, "█", Some((4, 2, true))),
    )
    .unwrap();
    let view = update(&mut screen);
    assert_eq!(view["rows"][0][0], 1);
    let start = view["rows"][0][1].as_u64().unwrap() as usize;
    assert_eq!(view["rows"][0][2][3 - start]["symbol"], "█");
    assert!(
        apply(
            &mut screen,
            &patch_geometry(2, 3, 4, 1, "x", Some((4, 2, true)))
        )
        .is_err()
    );
}
