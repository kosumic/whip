use herdr_protocol::{
    control::{HerdrControlRequest, HerdrControlResult, parse_response},
    events::{JsonlEventParser, StreamItem, subscription_request},
    terminal::{self, HerdrTerminalAttachLaunchMode, ServerMessage},
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protocol = 22;
    let hello = terminal::hello(
        protocol,
        80,
        24,
        8,
        16,
        HerdrTerminalAttachLaunchMode::for_protocol(protocol),
    )?;
    assert_eq!(hello, [0, 22, 80, 24, 8, 16, 0]);
    let welcome = terminal::decode(&[0, 22, 1, 0], protocol)?;
    assert!(matches!(
        welcome,
        ServerMessage::Welcome { protocol: 22, .. }
    ));

    let request = HerdrControlRequest::Ping;
    let encoded = request.encode("example-1")?;
    let response = parse_response(
        &request,
        br#"{"id":"example-1","result":{"type":"pong","version":"example","protocol":22}}"#,
    )?;
    assert!(matches!(
        response,
        HerdrControlResult::Pong { protocol: 22, .. }
    ));

    let subscribe = subscription_request(protocol, &["pane-1".into()])?;
    let mut parser = JsonlEventParser::default();
    let items = parser
        .push(b"{\"id\":\"android_events\",\"result\":{\"type\":\"subscription_started\"}}\n");
    assert_eq!(items, [StreamItem::Acknowledged]);
    println!("terminal hello: {hello:?}");
    println!("control request: {}", String::from_utf8(encoded)?.trim());
    println!("event request: {}", String::from_utf8(subscribe)?.trim());
    Ok(())
}
