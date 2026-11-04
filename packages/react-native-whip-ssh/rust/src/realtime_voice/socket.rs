//! One bounded wire interface for a direct WebSocket or a WebRTC sideband.
use futures::{Sink, Stream, channel::mpsc};
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Error, Message},
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
