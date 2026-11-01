use herdr_protocol::{
    control::{
        HerdrControlProtocolError, HerdrControlRequest, MAX_CONTROL_RESPONSE_BYTES, parse_response,
    },
    events::{HerdrEvent, JsonlEventParser, StreamItem},
    terminal::{self, CodecError, HerdrTerminalAttachLaunchMode, MAX_FRAME_BYTES, ServerMessage},
};

#[test]
fn published_protocol_generations_keep_their_golden_wire_layouts() {
    // Literal frames pin the v18 keyboard tag, v20 launch/bell additions,
    // v21 legacy preview, and v22 endpoint-generation-1 layout.
    type GoldenFrame = (
        u32,
        &'static [u8],
        &'static [u8],
        &'static [u8],
        &'static [u8],
    );
    let fixtures: &[GoldenFrame] = &[
        (
            17,
            &[0, 17, 80, 24, 8, 16, 1, 0, 1],
            &[3, 80, 24, 8, 16],
            &[2, 7, 80, 24, 1, 2, 0, 255],
            &[10, 1],
        ),
        (
            18,
            &[0, 18, 80, 24, 8, 16, 1, 0, 1],
            &[3, 80, 24, 8, 16],
            &[2, 7, 80, 24, 1, 2, 0, 255],
            &[11, 1],
        ),
        (
            19,
            &[0, 19, 80, 24, 8, 16, 1, 0, 1],
            &[3, 80, 24, 8, 16],
            &[2, 7, 80, 24, 1, 2, 0, 255],
            &[11, 1],
        ),
        (
            20,
            &[0, 20, 80, 24, 8, 16, 1, 0, 2],
            &[3, 80, 24, 8, 16],
            &[2, 7, 80, 24, 1, 2, 0, 255],
            &[11, 1],
        ),
        (
            21,
            &[0, 21, 80, 24, 8, 16, 1, 0, 2],
            &[3, 80, 24, 8, 16],
            &[2, 7, 80, 24, 1, 2, 0, 255],
            &[11, 1],
        ),
        (
            22,
            &[0, 22, 80, 24, 8, 16, 0],
            &[3, 80, 24, 8, 16, 0],
            &[1, 7, 80, 24, 1, 2, 0, 255],
            &[16, 8, 0],
        ),
    ];
    for &(protocol, hello, resize, frame, keyboard) in fixtures {
        assert_eq!(
            terminal::hello(
                protocol,
                80,
                24,
                8,
                16,
                HerdrTerminalAttachLaunchMode::for_protocol(protocol)
            )
            .unwrap(),
            hello
        );
        assert_eq!(terminal::resize(protocol, 80, 24, 8, 16).unwrap(), resize);
        assert_eq!(
            terminal::decode(frame, protocol).unwrap(),
            ServerMessage::Terminal {
                sequence: 7,
                width: 80,
                height: 24,
                full: true,
                bytes: vec![0, 255],
            }
        );
        let expected = if protocol == 22 {
            ServerMessage::KittyKeyboardReportAll { enabled: true }
        } else {
            ServerMessage::PrefixInputSource { enabled: true }
        };
        assert_eq!(terminal::decode(keyboard, protocol).unwrap(), expected);
    }
    assert_eq!(
        terminal::decode(&[10, 1], 18).unwrap(),
        ServerMessage::KittyKeyboardReportAll { enabled: true }
    );
    assert_eq!(
        terminal::decode(&[12, 2], 19).unwrap(),
        ServerMessage::Ignored { variant: 12 }
    );
    assert_eq!(
        terminal::decode(&[12, 2], 20).unwrap(),
        ServerMessage::TerminalBell { count: 2 }
    );
    assert_eq!(
        terminal::decode(&[9, 2], 22).unwrap(),
        ServerMessage::TerminalBell { count: 2 }
    );
}

#[test]
fn standalone_decoders_enforce_the_existing_transport_size_limits() {
    assert!(matches!(
        terminal::decode(&vec![0; MAX_FRAME_BYTES + 1], 22),
        Err(CodecError::InvalidValue("frame length"))
    ));
    assert!(matches!(
        parse_response(
            &HerdrControlRequest::Ping,
            &vec![b' '; MAX_CONTROL_RESPONSE_BYTES + 1]
        ),
        Err(HerdrControlProtocolError::MalformedResponse(_))
    ));
    assert!(matches!(
        terminal::decode(&[], 23),
        Err(CodecError::UnsupportedProtocol(23))
    ));
}

#[test]
fn event_acknowledgements_and_utf8_survive_transport_fragmentation() {
    let stream = concat!(
        "{\"id\":\"android_events\",\"result\":{\"type\":\"subscription_started\"}}\r\n",
        "{\"event\":\"workspace.renamed\",\"data\":{\"workspace_id\":\"w1\",\"label\":\"作業\"}}\n",
        "{\"event\":\"future.event\",\"data\":{}}\n"
    );
    let mut parser = JsonlEventParser::default();
    let items: Vec<_> = stream
        .as_bytes()
        .chunks(1)
        .flat_map(|bytes| parser.push(bytes))
        .collect();
    assert_eq!(
        items,
        [
            StreamItem::Acknowledged,
            StreamItem::Event(Box::new(HerdrEvent::WorkspaceRenamed {
                workspace_id: "w1".into(),
                label: "作業".into()
            })),
            StreamItem::Event(Box::new(HerdrEvent::ProtocolUnknown {
                raw_event: "future.event".into()
            })),
        ]
    );
}
