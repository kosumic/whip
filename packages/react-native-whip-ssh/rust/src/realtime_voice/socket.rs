//! One bounded wire interface for a direct WebSocket or a WebRTC sideband.
use futures::{Sink, SinkExt, Stream, channel::mpsc};
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
        last_pong: &mut tokio::time::Instant,
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
            Message::Pong(_) => *last_pong = tokio::time::Instant::now(),
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
    use futures::StreamExt;
    use std::time::Duration;

    #[tokio::test(start_paused = true)]
    async fn control_frames_preserve_heartbeat_and_text_delivery() {
        let (mut socket, mut commands, _events) = Socket::relay();
        let started = tokio::time::Instant::now();
        let mut last_pong = started;
        let payload = vec![1, 2, 3];
        assert!(
            socket
                .receive_text(
                    Some(Ok(Message::Ping(payload.clone().into()))),
                    &mut last_pong
                )
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(commands.next().await, Some(Message::Pong(payload.into())));
        assert_eq!(last_pong, started);
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(
            socket
                .receive_text(Some(Ok(Message::Pong(Vec::new().into()))), &mut last_pong)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(last_pong, tokio::time::Instant::now());
        let text = socket
            .receive_text(Some(Ok(Message::Text("event".into()))), &mut last_pong)
            .await
            .unwrap();
        assert_eq!(text.as_deref(), Some("event"));
    }
}
