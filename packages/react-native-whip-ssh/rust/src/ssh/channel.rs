//! Session channels retain ownership across cancelled opens and setup failures.
use super::{Session, client};
use std::ops::{Deref, DerefMut};

pub(super) struct SessionChannel(Option<russh::Channel<client::Msg>>);

impl SessionChannel {
    pub(super) fn new(channel: russh::Channel<client::Msg>) -> Self {
        Self(Some(channel))
    }

    /// Transfer cleanup to an established stream or a spawned channel loop.
    pub(super) fn into_channel(mut self) -> russh::Channel<client::Msg> {
        self.0
            .take()
            .unwrap_or_else(|| unreachable!("channel already transferred"))
    }

    pub(super) fn into_stream(self) -> russh::ChannelStream<client::Msg> {
        self.into_channel().into_stream()
    }

    pub(super) fn split(self) -> (russh::ChannelReadHalf, russh::ChannelWriteHalf<client::Msg>) {
        self.into_channel().split()
    }

    pub(super) async fn close(&mut self) -> Result<(), russh::Error> {
        if let Some(channel) = &self.0 {
            channel.close().await?;
        }
        self.0.take();
        Ok(())
    }
}

impl Deref for SessionChannel {
    type Target = russh::Channel<client::Msg>;

    fn deref(&self) -> &Self::Target {
        self.0
            .as_ref()
            .unwrap_or_else(|| unreachable!("channel already transferred"))
    }
}

impl DerefMut for SessionChannel {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0
            .as_mut()
            .unwrap_or_else(|| unreachable!("channel already transferred"))
    }
}

impl Drop for SessionChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            // Unlike ChannelStream, dropping a raw russh Channel does not send
            // SSH_MSG_CHANNEL_CLOSE. Errors and caller cancellation need it too.
            tokio::spawn(async move {
                let _ = channel.close().await;
            });
        }
    }
}

impl Session {
    pub(super) async fn open_session(&self) -> Result<SessionChannel, russh::Error> {
        let handle = self.handle.clone();
        let lifecycle = self.lifecycle.clone();
        let (mut reply, result) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let opening = tokio::select! {
                gate = lifecycle.session_open.lock() => gate,
                () = reply.closed() => return,
            };
            if reply.is_closed() {
                return;
            }
            // Keep a pending confirmation alive after cancellation. Otherwise
            // russh leaves the eventual server channel open with no owner.
            // The shared gate bounds pending confirmations to one per connection.
            let channel = handle.channel_open_session().await.map(SessionChannel::new);
            drop(opening);
            // A failed delivery drops the owned channel and closes it.
            let _ = reply.send(channel);
        });
        result.await.map_err(|_| russh::Error::Disconnect)?
    }
}
