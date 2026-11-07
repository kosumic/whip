//! Stop generation, then consume billing events without running audio or tools.
use super::{ClientEvent, RealtimeSocket, send, send_value};
use futures::StreamExt;
use oai_rt_rs::ServerEvent;
use serde_json::{Value, json};
use std::time::Duration;

pub const FINAL_USAGE_TIMEOUT: Duration = Duration::from_secs(3);
pub const QUIET_PERIOD: Duration = Duration::from_millis(250);
const MAX_EVENTS: usize = 256;
const CREDENTIAL_CHECK_INTERVAL: Duration = Duration::from_millis(50);

/// The socket and cost owner outlive the cancelled conversation future. This
/// collector never processes transcripts, media, tools, or response creation.
pub async fn collect(
    socket: &mut RealtimeSocket,
    costs: &mut impl UsageSink,
    webrtc: bool,
    credentials_current: impl Fn() -> bool,
) {
    let collect = async {
        if !credentials_current() {
            return Ok::<(), &'static str>(());
        }
        // Preserve explicit null: typed Option fields can omit it on encoding,
        // which would leave automatic VAD responses enabled during shutdown.
        send_value(
            socket,
            json!({"type":"session.update","session":{
                "type":"realtime", "audio":{"input":{"turn_detection":null}}
            }}),
        )
        .await?;
        send(
            socket,
            ClientEvent::InputAudioBufferClear { event_id: None },
        )
        .await?;
        send(
            socket,
            ClientEvent::ResponseCancel {
                event_id: None,
                response_id: None,
            },
        )
        .await?;
        if webrtc {
            send(
                socket,
                ClientEvent::OutputAudioBufferClear { event_id: None },
            )
            .await?;
        }
        let mut stop_confirmed = false;
        for _ in 0..MAX_EVENTS {
            if !credentials_current() {
                break;
            }
            // Pending responses/captions get the full deadline. Once terminal
            // reports arrive, allow a short tail for in-flight creation/events.
            let wait = if costs.has_pending_usage() || !stop_confirmed {
                FINAL_USAGE_TIMEOUT
            } else {
                QUIET_PERIOD
            };
            let Ok(message) = tokio::time::timeout(wait, socket.next()).await else {
                break;
            };
            let Some(text) = socket.receive_text(message).await? else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value["type"] == "session.updated"
                && value["session"]["audio"]["input"]
                    .as_object()
                    .is_some_and(|input| input.get("turn_detection") == Some(&Value::Null))
            {
                stop_confirmed = true;
            }
            let Ok(event) = serde_json::from_value::<ServerEvent>(value) else {
                continue;
            };
            costs.observe(&event);
            // A VAD response may already have been admitted before disabling
            // turn detection. Cancel it explicitly and retain its usage too.
            if let ServerEvent::ResponseCreated { response, .. } = event {
                send(
                    socket,
                    ClientEvent::ResponseCancel {
                        event_id: None,
                        response_id: Some(response.id),
                    },
                )
                .await?;
            }
        }
        Ok(())
    };
    let revoked = async {
        loop {
            if !credentials_current() {
                return;
            }
            tokio::time::sleep(CREDENTIAL_CHECK_INTERVAL).await;
        }
    };
    // Revocation also interrupts blocked writes, not only the receive loop.
    // Neither a silent provider nor a blocked write can delay cleanup forever.
    tokio::select! {
        biased;
        () = revoked => {},
        _ = tokio::time::timeout(FINAL_USAGE_TIMEOUT, collect) => {},
    }
}

/// Reports only billing events during finalization; never executes tools.
pub trait UsageSink {
    fn has_pending_usage(&self) -> bool;
    fn observe(&mut self, event: &ServerEvent);
}
