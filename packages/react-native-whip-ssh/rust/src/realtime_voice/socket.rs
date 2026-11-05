//! One bounded wire interface for a direct WebSocket or a WebRTC sideband.
use futures::{Sink, SinkExt, Stream, StreamExt, channel::mpsc};
use serde::Deserialize;
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Error, Message, Utf8Bytes},
};

pub(super) type RawSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
pub(super) type Events = mpsc::Sender<Result<Message, Error>>;

/// The transport owns WebSocket control frames, as in Codex's WsStream.
/// Reflected PCM is never admitted to the application queue: RTP owns audio.
pub(super) async fn next_sideband_event(socket: &mut RawSocket) -> Result<Message, &'static str> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Ping(payload))) => {
                tokio::time::timeout(super::IO_TIMEOUT, socket.send(Message::Pong(payload)))
                    .await
                    .map_err(|_| "Voice sideband pong timed out.")?
                    .map_err(|_| "Voice sideband disconnected.")?;
            }
            Some(Ok(Message::Pong(_) | Message::Frame(_))) => {}
            Some(Ok(Message::Text(text))) => {
                #[derive(Deserialize)]
                struct Kind<'a> {
                    #[serde(borrow, rename = "type")]
                    kind: &'a str,
                }
                let kind: Kind<'_> =
                    serde_json::from_str(&text).map_err(|_| "Invalid voice sideband event.")?;
                if !matches!(
                    kind.kind,
                    "session.input_audio.append"
                        | "session.output_audio.delta"
                        | "response.output_audio.delta"
                        | "response.audio.delta"
                ) {
                    return Ok(Message::Text(text));
                }
            }
            Some(Ok(message)) => return Ok(message),
            Some(Err(_)) | None => return Err("Voice sideband disconnected."),
        }
    }
}
pub(super) enum Socket {
    Direct(Box<RawSocket>),
    Sideband {
        outgoing: mpsc::Sender<Message>,
        incoming: mpsc::Receiver<Result<Message, Error>>,
    },
}
impl Socket {
    pub fn relay() -> (Self, mpsc::Receiver<Message>, Events) {
        let (outgoing, commands) = mpsc::channel(32);
        let (events, incoming) = mpsc::channel(32);
        (Self::Sideband { outgoing, incoming }, commands, events)
    }

    pub async fn receive_text(
        &mut self,
        message: Option<Result<Message, Error>>,
    ) -> Result<Option<Utf8Bytes>, &'static str> {
        let message = message
            .ok_or("OpenAI Realtime disconnected. Start a new call.")?
            .map_err(|_| "OpenAI Realtime connection failed.")?;
        match message {
            Message::Text(text) => return Ok(Some(text)),
            Message::Close(_) => return Err("OpenAI Realtime ended the call."),
            Message::Ping(payload) => {
                tokio::time::timeout(super::IO_TIMEOUT, self.send(Message::Pong(payload)))
                    .await
                    .map_err(|_| "Realtime send timed out.")?
                    .map_err(|_| "Realtime connection failed.")?;
            }
            _ => {}
        }
        Ok(None)
    }
}
impl Stream for Socket {
    type Item = Result<Message, Error>;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.get_mut() {
            Self::Direct(socket) => Pin::new(socket.as_mut()).poll_next(cx),
            Self::Sideband { incoming, .. } => Pin::new(incoming).poll_next(cx),
        }
    }
}
impl Sink<Message> for Socket {
    type Error = Error;
    fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        match self.get_mut() {
            Self::Direct(socket) => Pin::new(socket.as_mut()).poll_ready(cx),
            Self::Sideband { outgoing, .. } => Pin::new(outgoing)
                .poll_ready(cx)
                .map_err(|_| Error::ConnectionClosed),
        }
    }
    fn start_send(self: Pin<&mut Self>, message: Message) -> Result<(), Error> {
        match self.get_mut() {
            Self::Direct(socket) => Pin::new(socket.as_mut()).start_send(message),
            Self::Sideband { outgoing, .. } => Pin::new(outgoing)
                .start_send(message)
                .map_err(|_| Error::ConnectionClosed),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        match self.get_mut() {
            Self::Direct(socket) => Pin::new(socket.as_mut()).poll_flush(cx),
            Self::Sideband { outgoing, .. } => Pin::new(outgoing)
                .poll_flush(cx)
                .map_err(|_| Error::ConnectionClosed),
        }
    }
    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        match self.get_mut() {
            Self::Direct(socket) => Pin::new(socket.as_mut()).poll_close(cx),
            Self::Sideband { outgoing, .. } => Pin::new(outgoing)
                .poll_close(cx)
                .map_err(|_| Error::ConnectionClosed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn control_frames_preserve_ping_replies_and_text_delivery()
    -> Result<(), Box<dyn std::error::Error>> {
        let (mut socket, mut commands, _events) = Socket::relay();
        let payload = vec![1, 2, 3];
        assert!(
            socket
                .receive_text(Some(Ok(Message::Ping(payload.clone().into()))))
                .await?
                .is_none()
        );
        assert_eq!(commands.next().await, Some(Message::Pong(payload.into())));
        assert!(
            socket
                .receive_text(Some(Ok(Message::Pong(Vec::new().into()))))
                .await?
                .is_none()
        );
        let text = socket
            .receive_text(Some(Ok(Message::Text("event".into()))))
            .await?;
        assert_eq!(text.as_deref(), Some("event"));
        Ok(())
    }

    #[tokio::test]
    async fn sideband_keeps_control_and_reflected_audio_out_of_the_application_queue()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let mut socket = tokio_tungstenite::accept_async(stream).await?;
            for kind in [
                "session.input_audio.append",
                "session.output_audio.delta",
                "response.output_audio.delta",
                "response.audio.delta",
            ] {
                socket
                    .send(Message::Text(
                        serde_json::json!({"type":kind,"delta":"synthetic-pcm"})
                            .to_string()
                            .into(),
                    ))
                    .await?;
            }
            socket.send(Message::Pong(vec![7].into())).await?;
            socket.send(Message::Ping(vec![8].into())).await?;
            assert_eq!(
                socket.next().await.transpose()?,
                Some(Message::Pong(vec![8].into()))
            );
            socket
                .send(Message::Text(r#"{"type":"session.updated"}"#.into()))
                .await?;
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
        });
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}")).await?;
        let event = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            next_sideband_event(&mut socket),
        )
        .await??;
        assert_eq!(event, Message::Text(r#"{"type":"session.updated"}"#.into()));
        server
            .await?
            .map_err(|_| "Synthetic sideband server failed")?;
        Ok(())
    }
}
