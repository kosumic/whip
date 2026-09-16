use super::*;

#[test]
fn russh_transport_disconnect_marks_the_connection_dead_once() {
    runtime().unwrap().block_on(async {
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        let mut handler = RusshHandler {
            host: "host.test".to_owned(),
            port: 22,
            agent: Arc::new(AgentState::default()),
            lifecycle: lifecycle.clone(),
        };
        client::Handler::disconnected(
            &mut handler,
            client::DisconnectReason::ReceivedDisconnect(client::RemoteDisconnectInfo {
                reason_code: russh::Disconnect::ConnectionLost,
                message: "network path lost".to_owned(),
                lang_tag: "en".to_owned(),
            }),
        )
        .await
        .unwrap();

        assert!(!lifecycle.is_alive());
        assert!(!lifecycle.mark_disconnected("second observation"));
        assert_eq!(
            lifecycle.disconnected().await.reason,
            "remote SSH disconnect (ConnectionLost): network path lost"
        );
    });
}

#[test]
fn russh_transport_error_is_published_and_returned() {
    runtime().unwrap().block_on(async {
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        let mut handler = RusshHandler {
            host: "host.test".to_owned(),
            port: 22,
            agent: Arc::new(AgentState::default()),
            lifecycle: lifecycle.clone(),
        };
        let result = client::Handler::disconnected(
            &mut handler,
            client::DisconnectReason::Error(TransportError::Ssh(russh::Error::HUP)),
        )
        .await;

        assert!(matches!(
            result,
            Err(TransportError::Ssh(russh::Error::HUP))
        ));
        assert!(!lifecycle.is_alive());
        assert!(!lifecycle.disconnected().await.reason.is_empty());
    });
}

#[test]
fn latency_probe_fails_when_transport_dies_during_ping() {
    runtime().unwrap().block_on(async {
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let probe_lifecycle = lifecycle.clone();
        let probe = tokio::spawn(async move {
            latency_probe(&probe_lifecycle, false, async move {
                let _ = started.send(());
                std::future::pending::<Result<(), russh::Error>>().await
            })
            .await
        });
        started_rx.await.unwrap();
        lifecycle.mark_disconnected("test transport loss");

        let error = probe.await.unwrap().unwrap_err();
        assert!(matches!(
            error,
            TransportError::SessionClosed(reason) if reason == "test transport loss"
        ));
    });
}

#[test]
fn latency_probe_fails_immediately_for_closed_session() {
    runtime().unwrap().block_on(async {
        let lifecycle = ConnectionLifecycle::default();
        lifecycle.mark_disconnected("already closed");
        let error = latency_probe(
            &lifecycle,
            false,
            std::future::pending::<Result<(), russh::Error>>(),
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            TransportError::SessionClosed(reason) if reason == "already closed"
        ));
    });
}

#[test]
fn terminal_reader_drains_while_write_is_flow_controlled() {
    runtime().unwrap().block_on(async {
        let (write_started, write_started_rx) = tokio::sync::oneshot::channel();
        let incoming_drained = Arc::new(AtomicBool::new(false));
        let drained = incoming_drained.clone();
        let read_loop = async move {
            write_started_rx.await.unwrap();
            drained.store(true, Ordering::SeqCst);
            "remote shell EOF".to_owned()
        };
        let write_loop = async move {
            let _ = write_started.send(());
            std::future::pending::<String>().await
        };

        assert_eq!(
            select_channel_loops(
                read_loop,
                write_loop,
                std::future::pending::<String>(),
                |reason| reason,
            )
            .await,
            "remote shell EOF"
        );
        assert!(incoming_drained.load(Ordering::SeqCst));
    });
}

#[test]
fn shell_failures_keep_concise_write_and_resize_reasons() {
    let error = russh::Error::WrongChannel;
    assert_eq!(
        shell_write_failure("channel write", &error),
        format!("SSH channel write failed: {error}")
    );
    assert_eq!(
        shell_write_failure("resize", &error),
        format!("SSH resize failed: {error}")
    );
}

#[test]
fn normal_shell_eof_does_not_mark_transport_dead() {
    let lifecycle = ConnectionLifecycle::default();
    assert_eq!(shell_eof_reason("remote shell closed"), "remote shell EOF");
    assert!(lifecycle.is_alive());
}

#[test]
fn russh_host_certificates_are_explicitly_rejected() {
    runtime().unwrap().block_on(async {
        let mut rng =
            russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
        let ca =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519).unwrap();
        let subject =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519).unwrap();
        let mut builder = russh::keys::ssh_key::certificate::Builder::new_with_random_nonce(
            &mut rng,
            subject.public_key(),
            0,
            u64::MAX,
        )
        .unwrap();
        builder
            .cert_type(russh::keys::ssh_key::certificate::CertType::Host)
            .unwrap();
        builder.valid_principal("host.test").unwrap();
        let certificate = builder.sign(&ca).unwrap();
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        let mut handler = RusshHandler {
            host: "host.test".to_owned(),
            port: 22,
            agent: Arc::new(AgentState::default()),
            lifecycle,
        };

        let result = client::Handler::check_server_key(
            &mut handler,
            &PublicKeyOrCertificate::Certificate(certificate),
        )
        .await;
        assert!(matches!(
            result,
            Err(TransportError::UnsupportedHostCertificate)
        ));
    });
}

#[test]
fn grouped_channels_scope_shared_ids_by_owner_and_prune_empty_owners() {
    let mut channels = GroupedChannels::default();
    assert_eq!(
        channels.insert("session-a".into(), "shared".into(), 1),
        None
    );
    assert_eq!(
        channels.insert("session-b".into(), "shared".into(), 2),
        None
    );
    assert_eq!(channels.insert("session-a".into(), "other".into(), 3), None);
    assert_eq!(channels.get("session-a", "shared"), Some(&1));
    assert_eq!(channels.get("session-b", "shared"), Some(&2));

    assert_eq!(
        channels.insert("session-a".into(), "shared".into(), 4),
        Some(1)
    );
    channels.remove_if("session-a", "shared", |value| *value == 1);
    assert_eq!(channels.get("session-a", "shared"), Some(&4));
    channels.remove_if("session-a", "shared", |value| *value == 4);
    assert!(!channels.contains("session-a", "shared"));
    assert!(channels.0.contains_key("session-a"));

    assert_eq!(channels.remove("session-a", "other"), Some(3));
    assert!(!channels.0.contains_key("session-a"));
    assert_eq!(channels.get("session-b", "shared"), Some(&2));

    let removed = channels.remove_owner("session-b").unwrap();
    assert_eq!(removed.get("shared"), Some(&2));
    assert!(channels.0.is_empty());
}

#[test]
fn transport_errors_have_stable_codes() {
    assert_eq!(
        transport_error_code(&TransportError::AuthenticationFailed),
        SshErrorCode::AuthenticationFailed,
    );
    assert_eq!(
        transport_error_code(&TransportError::Io(std::io::Error::from(
            std::io::ErrorKind::ConnectionRefused,
        ))),
        SshErrorCode::ConnectionRefused,
    );
    assert_eq!(
        transport_error_code(&TransportError::Ssh(russh::Error::WrongChannel)),
        SshErrorCode::ChannelUnavailable,
    );
    assert_eq!(
        transport_error_code(&TransportError::UnsupportedHostCertificate),
        SshErrorCode::UnsupportedHostCertificate,
    );
    assert!(matches!(
        classify_direct_connect_error(TransportError::Ssh(russh::Error::IO(
            std::io::Error::other("host lookup failed"),
        ))),
        TransportError::HostUnreachable(_),
    ));
}

#[test]
fn unsupported_host_certificates_keep_their_native_error_type() {
    assert_eq!(
        SshError::from(TransportError::UnsupportedHostCertificate),
        SshError::UnsupportedHostCertificate,
    );

    assert_eq!(
        SshFailure::from(TransportError::UnsupportedHostCertificate),
        SshFailure::UnsupportedHostCertificate,
    );
}

#[test]
fn host_key_errors_carry_structured_challenges() {
    let mut rng =
        russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
    let private_key =
        russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519).unwrap();
    let HostKeyDecision::Unknown(challenge) =
        KnownHosts::default().check("Example.COM", 2222, private_key.public_key())
    else {
        panic!("empty known_hosts should reject the key as unknown");
    };
    let SshError::HostKeyUnknown(details) =
        SshError::from(TransportError::HostKeyUnknown(challenge))
    else {
        panic!("host-key challenge lost its typed error variant");
    };
    assert_eq!(details.host, "example.com");
    assert_eq!(details.port, 2222);
    assert_eq!(details.key_type, "ssh-ed25519");
    assert!(details.fingerprint.starts_with("SHA256:"));
    assert!(details.public_key.starts_with("ssh-ed25519 "));
}

#[test]
fn remote_home_command_expands_without_literal_quotes() {
    assert_eq!(REMOTE_HOME_COMMAND, "printf %s \"$HOME\"");
}

#[test]
fn exec_close_reason_preserves_bounded_remote_diagnostics() {
    assert_eq!(
        exec_channel_close_reason(Some(127), b"sh: tail: not found\n"),
        "remote exec channel exited with status 127: sh: tail: not found"
    );
    assert_eq!(
        exec_channel_close_reason(Some(75), b"source replaced\r\ntry again"),
        "remote exec channel exited with status 75: source replaced  try again"
    );
    assert_eq!(
        exec_channel_close_reason(Some(0), b""),
        "remote exec channel reached EOF"
    );
}

#[test]
fn blocked_transfer_io_cancels_promptly_and_does_not_poison_the_next_transfer() {
    runtime().unwrap().block_on(async {
        let (blocked_destination, _blocked_reader) = tokio::io::duplex(1);
        let (cancel_sender, mut cancel) = watch::channel(false);
        let transfer = tokio::spawn(async move {
            copy_sftp_stream(
                std::io::Cursor::new(vec![7u8; 64 * 1024]),
                blocked_destination,
                Some(64 * 1024),
                "upload",
                &mut cancel,
                &mut |_, _| {},
            )
            .await
        });

        // The one-byte duplex capacity leaves write_all blocked in the
        // middle of its first chunk until cancellation wins the select.
        tokio::time::sleep(Duration::from_millis(10)).await;
        cancel_sender.send(true).unwrap();
        let error = tokio::time::timeout(Duration::from_millis(100), transfer)
            .await
            .expect("cancelled transfer should settle promptly")
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("cancelled"));

        let (_next_cancel_sender, mut next_cancel) = watch::channel(false);
        copy_sftp_stream(
            std::io::Cursor::new(b"next upload".to_vec()),
            tokio::io::sink(),
            Some(11),
            "upload",
            &mut next_cancel,
            &mut |_, _| {},
        )
        .await
        .expect("a later transfer should still succeed");
    });
}

#[test]
fn transfer_progress_reports_final_bytes_for_known_unknown_and_empty_sources() {
    runtime().unwrap().block_on(async {
        for (payload, total) in [
            (b"payload".as_slice(), Some(7)),
            (b"payload".as_slice(), None),
            (b"".as_slice(), Some(0)),
        ] {
            let (_sender, mut cancel) = watch::channel(false);
            let mut updates = Vec::new();
            let mut destination = Vec::new();
            copy_sftp_stream(
                std::io::Cursor::new(payload),
                &mut destination,
                total,
                "download",
                &mut cancel,
                &mut |copied, total| updates.push((copied, total)),
            )
            .await
            .unwrap();
            assert_eq!(destination, payload);
            assert_eq!(updates.first(), Some(&(0, total)));
            assert_eq!(updates.last(), Some(&(payload.len() as u64, total)));
        }
    });
}

#[test]
fn parses_file_preview_get_head_and_single_ranges() {
    assert_eq!(
        parse_sftp_http_request(
            b"GET /secret/video.mp4 HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=10-19\r\n\r\n",
        )
        .unwrap(),
        SftpHttpRequest {
            head: false,
            path: "/secret/video.mp4".to_owned(),
            range: Some("bytes=10-19".to_owned()),
        },
    );
    assert!(parse_sftp_http_request(b"POST /secret/video.mp4 HTTP/1.1\r\n\r\n").is_err());
    assert_eq!(parse_sftp_http_range(None, 100), Ok((0, 99, false)));
    assert_eq!(
        parse_sftp_http_range(Some("bytes=10-19"), 100),
        Ok((10, 19, true)),
    );
    assert_eq!(
        parse_sftp_http_range(Some("bytes=90-"), 100),
        Ok((90, 99, true)),
    );
    assert_eq!(
        parse_sftp_http_range(Some("bytes=-10"), 100),
        Ok((90, 99, true)),
    );
    assert!(parse_sftp_http_range(Some("bytes=100-"), 100).is_err());
    assert!(parse_sftp_http_range(Some("bytes=0-1,4-5"), 100).is_err());
}

#[test]
fn assigns_inline_media_content_types() {
    assert_eq!(sftp_http_content_type("/tmp/report.PDF"), "application/pdf");
    assert_eq!(sftp_http_content_type("/tmp/movie.mp4"), "video/mp4");
    assert_eq!(sftp_http_content_type("/tmp/audio.flac"), "audio/flac");
    assert_eq!(
        sftp_http_content_type("/tmp/archive.bin"),
        "application/octet-stream",
    );
}

#[test]
fn typed_fast_paths_report_missing_channels_without_json() {
    assert!(matches!(
        write_shell_input("missing-shell".to_owned(), "x".to_owned()),
        Err(SshError::SessionClosed(_)),
    ));
    for error in [
        write_unix_socket_channel(
            "missing-client".to_owned(),
            "missing-channel".to_owned(),
            vec![1, 2, 3],
        ),
        write_length_prefixed_unix_socket_channel(
            "missing-client".to_owned(),
            "missing-channel".to_owned(),
            vec![1, 2, 3],
        ),
    ] {
        let SshError::ChannelUnavailable(message) = error.unwrap_err() else {
            panic!("missing Unix-socket channel lost its typed error variant");
        };
        assert!(message.contains("Unix-socket channel 'missing-channel' is not open"));
    }
    let SshError::ChannelUnavailable(message) = write_exec_channel(
        "missing-client".to_owned(),
        "missing-channel".to_owned(),
        vec![1, 2, 3],
    )
    .unwrap_err() else {
        panic!("missing exec channel lost its typed error variant");
    };
    assert!(message.contains("exec channel 'missing-channel' is not open"));
}

#[test]
fn encodes_supported_frame_length_formats() {
    assert_eq!(LengthFormat::U8.prefix(42).unwrap(), vec![42]);
    assert_eq!(
        LengthFormat::U16Le.prefix(0x1234).unwrap(),
        vec![0x34, 0x12]
    );
    assert_eq!(
        LengthFormat::U16Be.prefix(0x1234).unwrap(),
        vec![0x12, 0x34]
    );
    assert_eq!(
        LengthFormat::U32Le.prefix(0x1234_5678).unwrap(),
        vec![0x78, 0x56, 0x34, 0x12],
    );
    assert_eq!(
        LengthFormat::U32Be.prefix(0x1234_5678).unwrap(),
        vec![0x12, 0x34, 0x56, 0x78],
    );
    assert!(LengthFormat::U8.prefix(256).is_err());
}

#[test]
fn reads_complete_length_prefixed_payloads() {
    runtime().unwrap().block_on(async {
        let mut input = &b"\x03\0\0\0abc\0\0\0\0"[..];
        let mut reader = LengthPrefixedFrameReader::new(LengthFormat::U32Le, 1024);
        assert_eq!(
            reader.read_frame(&mut input).await.unwrap(),
            Some(b"abc".to_vec()),
        );
        assert_eq!(
            reader.read_frame(&mut input).await.unwrap(),
            Some(Vec::new())
        );
        assert_eq!(reader.read_frame(&mut input).await.unwrap(), None);

        let mut oversized = &b"\x04\0\0\0abcd"[..];
        let mut reader = LengthPrefixedFrameReader::new(LengthFormat::U32Le, 3);
        assert!(reader.read_frame(&mut oversized).await.is_err());
    });
}

#[test]
fn preserves_partial_frame_state_when_a_read_is_cancelled() {
    runtime().unwrap().block_on(async {
        let (mut writer, mut input) = tokio::io::duplex(64);
        let mut reader = LengthPrefixedFrameReader::new(LengthFormat::U32Le, 1024);

        writer.write_all(b"\x03\0").await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), reader.read_frame(&mut input),)
                .await
                .is_err()
        );

        writer.write_all(b"\0\0abc").await.unwrap();
        assert_eq!(
            reader.read_frame(&mut input).await.unwrap(),
            Some(b"abc".to_vec()),
        );
    });
}

#[test]
fn outbound_writes_continue_when_inbound_delivery_is_backpressured() {
    runtime().unwrap().block_on(async {
        let (socket, mut remote) = tokio::io::duplex(1024);
        let (socket_reader, socket_writer) = tokio::io::split(socket);
        let (delivery_sender, delivery_receiver) = mpsc::channel(1);
        let byte_budget = Arc::new(Semaphore::new(1));
        let held_permit = byte_budget
            .clone()
            .acquire_owned()
            .await
            .expect("test byte budget should be open");
        delivery_sender
            .send(OwnedInboundFrame {
                bytes: vec![0],
                _byte_permit: held_permit,
            })
            .await
            .unwrap();

        let read_task = tokio::spawn(read_unix_socket_frames(
            socket_reader,
            Some(LengthFormat::U32Le),
            1024,
            delivery_sender,
            byte_budget,
        ));
        remote.write_all(b"\x03\0\0\0abc").await.unwrap();

        let (control_sender, control_receiver) = mpsc::channel(1);
        let write_task = tokio::spawn(write_unix_socket_commands(socket_writer, control_receiver));
        control_sender
            .send(StreamCommand::Write(b"out".to_vec()))
            .await
            .unwrap();
        let mut output = [0; 3];
        tokio::time::timeout(Duration::from_millis(100), remote.read_exact(&mut output))
            .await
            .expect("outbound write must not wait for inbound delivery")
            .unwrap();
        assert_eq!(&output, b"out");

        control_sender.send(StreamCommand::Close).await.unwrap();
        assert_eq!(
            write_task.await.unwrap(),
            ("Unix-socket channel closed by client".to_owned(), true),
        );
        read_task.abort();
        drop(delivery_receiver);
    });
}

#[test]
fn answers_standard_keyboard_interactive_password_prompts() {
    let prompts = [client::Prompt {
        prompt: "Password:".to_owned(),
        echo: false,
    }];
    assert_eq!(
        keyboard_interactive_password_responses(&prompts, "a1", "secret"),
        Some(vec!["secret".to_owned()]),
    );
}

#[test]
fn refuses_unknown_keyboard_interactive_challenges() {
    let prompts = [
        client::Prompt {
            prompt: "Password:".to_owned(),
            echo: false,
        },
        client::Prompt {
            prompt: "Verification code:".to_owned(),
            echo: false,
        },
    ];
    assert_eq!(
        keyboard_interactive_password_responses(&prompts, "a1", "secret"),
        None,
    );
}

#[test]
fn generated_ed25519_key_round_trips_through_inspection() {
    let generated = generate_key_pair("ed25519", "test-passphrase", "russh-test").unwrap();
    let details = key_details(&generated.private_key, Some("test-passphrase")).unwrap();
    assert_eq!(details.key_type, "ssh-ed25519");
    assert_eq!(details.key_size, 256);
    assert_eq!(details.public_key, generated.public_key);
    assert!(details.fingerprint.starts_with("SHA256:"));
}

#[test]
fn forwarded_agent_lists_and_signs_with_the_authenticated_key() {
    let mut rng =
        russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
    let private_key = Arc::new(
        russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519).unwrap(),
    );
    let state = Arc::new(AgentState::default());

    runtime().unwrap().block_on(async {
        initialize_agent(private_key, state.clone()).await.unwrap();
        let (client_stream, server_stream) = tokio::io::duplex(256 * 1024);
        state
            .sender
            .read()
            .as_ref()
            .unwrap()
            .unbounded_send(Ok(Box::new(server_stream)))
            .unwrap();
        let mut client = russh::keys::agent::client::AgentClient::connect(client_stream);
        let identities = client.request_identities().await.unwrap();
        assert_eq!(identities.len(), 1);
        let payload = b"agent-forwarding-test".to_vec();
        let signed = client
            .sign_request(&identities[0], None, payload.clone())
            .await
            .unwrap();
        assert!(signed.starts_with(&payload));
        assert!(signed.len() > payload.len());
    });
}

#[test]
#[ignore = "run through tests/live-ssh.sh"]
#[allow(
    clippy::too_many_lines,
    reason = "the live integration test intentionally exercises one sequential OpenSSH feature matrix"
)]
fn live_openssh_feature_matrix() {
    let host = std::env::var("RUSSH_SSH_TEST_HOST").expect("missing test host");
    let port = std::env::var("RUSSH_SSH_TEST_PORT")
        .expect("missing test port")
        .parse::<u16>()
        .expect("invalid test port");
    let target_port = std::env::var("RUSSH_SSH_TEST_TARGET_PORT")
        .expect("missing target port")
        .parse::<u16>()
        .expect("invalid target port");
    let username = std::env::var("RUSSH_SSH_TEST_USER").expect("missing test user");
    let private_key = std::fs::read_to_string(
        std::env::var("RUSSH_SSH_TEST_PRIVATE_KEY").expect("missing private key path"),
    )
    .expect("could not read private key");
    let known_hosts_contents = std::fs::read_to_string(
        std::env::var("RUSSH_SSH_TEST_KNOWN_HOSTS").expect("missing known_hosts path"),
    )
    .expect("could not read known_hosts");
    let shared = std::path::PathBuf::from(
        std::env::var("RUSSH_SSH_TEST_SHARED_DIR").expect("missing shared directory"),
    );

    runtime().unwrap().block_on(async {
        *known_hosts().write() = KnownHosts::parse(&known_hosts_contents);
        let key_authentication = SshAuthentication::Key {
            private_key: private_key.clone(),
            passphrase: None,
        };
        connect_compatibility_session(
            host.clone(),
            port,
            username.clone(),
            key_authentication.clone(),
            "live-main".to_owned(),
            None,
        )
        .await
        .unwrap();
        let main_session = session_for_key("live-main").unwrap();
        let executed = execute_on(&main_session, "printf russh-live")
            .await
            .unwrap();
        assert_eq!(executed.stdout, b"russh-live");

        main_session.agent.enabled.store(true, Ordering::Relaxed);
        let agent = execute_on(&main_session, "ssh-add -L").await.unwrap();
        assert!(String::from_utf8_lossy(&agent.stdout).contains("ssh-ed25519"));

        connect_sftp_on("live-main", &main_session).await.unwrap();
        let managed_session = SshSession::registered("live-main").unwrap();
        let remote_nested = "/workspace/remote/nested";
        sftp_create_dir_all_on(&sftp_for_key("live-main").unwrap(), remote_nested)
            .await
            .unwrap();
        sftp_create_dir_all_on(&sftp_for_key("live-main").unwrap(), remote_nested)
            .await
            .unwrap();
        let client_dir = shared.join("client");
        let download_dir = shared.join("download");
        fs::create_dir_all(&client_dir).await.unwrap();
        fs::create_dir_all(&download_dir).await.unwrap();
        let payload = client_dir.join("payload.txt");
        fs::write(&payload, b"sftp-live-payload").await.unwrap();
        let uploaded = sftp_transfer_on(
            "live-main".to_owned(),
            sftp_for_key("live-main").unwrap(),
            payload.to_string_lossy().into_owned(),
            remote_nested.to_owned(),
            true,
            false,
        )
        .await
        .unwrap();
        assert!(uploaded.is_empty(), "legacy uploads return an empty string");
        let mkdir_collision = sftp_create_dir_all_on(
            &sftp_for_key("live-main").unwrap(),
            "/workspace/remote/nested/payload.txt/child",
        )
        .await
        .unwrap_err();
        assert!(mkdir_collision.to_string().contains("is not a directory"));
        fs::write(&payload, b"sftp-live-replacement").await.unwrap();
        let managed_remote = format!("{remote_nested}/payload.txt");
        for permissions in [0o755, 0o600] {
            sftp_mutation(
                "live-main",
                managed_remote.clone(),
                SftpMutation::Chmod(permissions),
            )
            .await
            .unwrap();
            let (_cancel_sender, cancel) = watch::channel(false);
            sftp_transfer_file_on(
                sftp_for_key("live-main").unwrap(),
                payload.to_string_lossy().into_owned(),
                managed_remote.clone(),
                true,
                cancel,
                |_, _| {},
            )
            .await
            .unwrap();
            let metadata = sftp_for_key("live-main")
                .unwrap()
                .metadata(managed_remote.clone())
                .await
                .unwrap();
            assert_eq!(metadata.permissions.unwrap() & 0o7777, permissions);
            assert_eq!(
                sftp_for_key("live-main")
                    .unwrap()
                    .read(managed_remote.clone())
                    .await
                    .unwrap(),
                b"sftp-live-replacement"
            );
        }
        let generated_path = "/workspace/remote/nested/generated-name.txt";
        sftp_transfer_on(
            "live-main".to_owned(),
            sftp_for_key("live-main").unwrap(),
            payload.to_string_lossy().into_owned(),
            generated_path.to_owned(),
            true,
            true,
        )
        .await
        .unwrap();
        for _ in 0..2 {
            let (_sender, cancel) = watch::channel(false);
            let updates = Arc::new(RwLock::new(Vec::new()));
            let progress_updates = updates.clone();
            let uploaded = managed_session
                .transfer_upload(
                    payload.to_str().unwrap(),
                    generated_path,
                    cancel,
                    Arc::new(move |bytes, total| progress_updates.write().push((bytes, total))),
                )
                .await
                .unwrap();
            assert_eq!(uploaded, generated_path);
            let updates = updates.read();
            assert_eq!(updates.first(), Some(&(0, Some(21))));
            assert_eq!(updates.last(), Some(&(21, Some(21))));
        }
        sftp_mutation(
            "live-main",
            "/workspace/remote/nested/generated-name.txt".to_owned(),
            SftpMutation::Chmod(0o640),
        )
        .await
        .unwrap();
        sftp_for_key("live-main")
            .unwrap()
            .rename(
                "/workspace/remote/nested/generated-name.txt".to_owned(),
                "/workspace/remote/nested/renamed.txt".to_owned(),
            )
            .await
            .unwrap();
        let entries = sftp_list_on(&sftp_for_key("live-main").unwrap(), remote_nested)
            .await
            .unwrap();
        assert!(
            entries
                .iter()
                .any(|entry| entry.filename.contains("renamed.txt"))
        );
        assert!(
            !entries
                .iter()
                .any(|entry| { entry.filename.contains(".whip-") })
        );
        let downloaded = sftp_transfer_on(
            "live-main".to_owned(),
            sftp_for_key("live-main").unwrap(),
            download_dir.to_string_lossy().into_owned(),
            "/workspace/remote/nested/renamed.txt".to_owned(),
            false,
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read(&downloaded).await.unwrap(),
            b"sftp-live-replacement"
        );
        let (_sender, cancel) = watch::channel(false);
        fs::write(&downloaded, b"old download").await.unwrap();
        let managed_download = managed_session
            .transfer_download(
                "/workspace/remote/nested/renamed.txt",
                &downloaded,
                cancel,
                Arc::new(|_, _| {}),
            )
            .await
            .unwrap();
        assert_eq!(managed_download, downloaded);
        assert_eq!(
            fs::read(&downloaded).await.unwrap(),
            b"sftp-live-replacement"
        );

        let (_sender, cancel) = watch::channel(false);
        let directory_error = managed_session
            .transfer_upload(
                payload.to_str().unwrap(),
                remote_nested,
                cancel,
                Arc::new(|_, _| {}),
            )
            .await
            .unwrap_err();
        assert!(
            directory_error
                .to_string()
                .contains("destination is a directory")
        );
        assert!(shared.join("remote/nested").is_dir());

        let file_server = start_sftp_file_server_on(
            "live-main".to_owned(),
            main_session.clone(),
            "/workspace/remote/nested/renamed.txt".to_owned(),
        )
        .await
        .unwrap();
        let mut preview = tokio::net::TcpStream::connect(("127.0.0.1", file_server.local_port))
            .await
            .unwrap();
        preview
            .write_all(
                format!(
                    "GET /{}/renamed.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=10-20\r\n\r\n",
                    file_server.token,
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut preview_response = Vec::new();
        preview.read_to_end(&mut preview_response).await.unwrap();
        let preview_response = String::from_utf8(preview_response).unwrap();
        assert!(preview_response.starts_with("HTTP/1.1 206 Partial Content\r\n"));
        assert!(preview_response.contains("Content-Range: bytes 10-20/21\r\n"));
        assert!(preview_response.ends_with("replacement"));
        close_ssh_sftp_file_server("live-main".to_owned(), file_server.local_port);

        let cancel_payload = client_dir.join("cancel.bin");
        fs::write(&cancel_payload, vec![7u8; 16 * 1024 * 1024])
            .await
            .unwrap();
        let transfer = runtime().unwrap().spawn(sftp_transfer_on(
            "live-main".to_owned(),
            sftp_for_key("live-main").unwrap(),
            cancel_payload.to_string_lossy().into_owned(),
            "/workspace/remote".to_owned(),
            true,
            false,
        ));
        while !transfers()
            .read()
            .contains_key(&("live-main".to_owned(), "upload"))
        {
            tokio::task::yield_now().await;
        }
        assert!(cancel_ssh_sftp_upload("live-main".to_owned()));
        let transfer_error = tokio::time::timeout(Duration::from_secs(1), transfer)
            .await
            .expect("cancelled upload should settle promptly")
            .unwrap()
            .unwrap_err()
            .to_string();
        assert!(transfer_error.contains("cancelled"));
        let entries = sftp_list_on(&sftp_for_key("live-main").unwrap(), "/workspace/remote")
            .await
            .unwrap();
        assert!(
            !entries.iter().any(|entry| {
                entry.filename == "cancel.bin" || entry.filename.contains(".whip-")
            })
        );
        // Cancel through the app adapter after copying starts. Both directions
        // must preserve an existing destination and remove the staged file.
        let remote_cancel = "/workspace/remote/cancel.bin";
        let sftp = sftp_for_key("live-main").unwrap();
        {
            let mut prior = sftp.create(remote_cancel).await.unwrap();
            prior.write_all(b"prior upload").await.unwrap();
            prior.shutdown().await.unwrap();
        }
        let (sender, cancel) = watch::channel(false);
        let error = managed_session
            .transfer_upload(
                cancel_payload.to_str().unwrap(),
                remote_cancel,
                cancel,
                Arc::new(move |bytes, _| {
                    if bytes > 0 {
                        sender.send(true).unwrap();
                    }
                }),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("cancelled"));
        assert_eq!(sftp.read(remote_cancel).await.unwrap(), b"prior upload");
        sftp.write(remote_cancel, &fs::read(&cancel_payload).await.unwrap())
            .await
            .unwrap();
        let (sender, cancel) = watch::channel(false);
        let error = managed_session
            .transfer_download(
                remote_cancel,
                &downloaded,
                cancel,
                Arc::new(move |bytes, _| {
                    if bytes > 0 {
                        sender.send(true).unwrap();
                    }
                }),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("cancelled"));
        assert_eq!(
            fs::read(&downloaded).await.unwrap(),
            b"sftp-live-replacement"
        );
        let entries = sftp_list_on(&sftp_for_key("live-main").unwrap(), "/workspace/remote")
            .await
            .unwrap();
        assert!(
            !entries
                .iter()
                .any(|entry| entry.filename.contains(".whip-"))
        );
        let mut entries = fs::read_dir(&download_dir).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            assert!(!entry.file_name().to_string_lossy().contains(".whip-"));
        }
        sftp_transfer_on(
            "live-main".to_owned(),
            sftp_for_key("live-main").unwrap(),
            payload.to_string_lossy().into_owned(),
            "/workspace/remote/after-cancel.txt".to_owned(),
            true,
            true,
        )
        .await
        .unwrap();
        let entries = sftp_list_on(&sftp_for_key("live-main").unwrap(), "/workspace/remote")
            .await
            .unwrap();
        assert!(
            entries
                .iter()
                .any(|entry| entry.filename == "after-cancel.txt")
        );

        let forward_port = open_local_forward_on(
            "live-main".to_owned(),
            main_session,
            "127.0.0.1".to_owned(),
            target_port,
        )
        .await
        .unwrap();
        let mut forwarded = tokio::net::TcpStream::connect(("127.0.0.1", forward_port))
            .await
            .unwrap();
        let mut banner = [0u8; 4];
        tokio::time::timeout(Duration::from_secs(5), forwarded.read_exact(&mut banner))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&banner, b"SSH-");
        close_local_forward_for_key("live-main", forward_port);

        connect_compatibility_session(
            "127.0.0.1".to_owned(),
            target_port,
            username.clone(),
            key_authentication,
            "live-jump-target".to_owned(),
            Some("live-main".to_owned()),
        )
        .await
        .unwrap();
        let jumped = execute_on(
            &session_for_key("live-jump-target").unwrap(),
            "printf jumped",
        )
        .await
        .unwrap();
        assert_eq!(jumped.stdout, b"jumped");

        connect_compatibility_session(
            host,
            port,
            username,
            SshAuthentication::Password {
                password: "russh-test-password".to_owned(),
            },
            "live-password".to_owned(),
            None,
        )
        .await
        .unwrap();
        disconnect_key("live-password".to_owned()).await;
        disconnect_key("live-jump-target".to_owned()).await;
        disconnect_key("live-main".to_owned()).await;
    });
}
