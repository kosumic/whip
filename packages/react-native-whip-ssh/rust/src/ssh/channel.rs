//! SSH channels retain ownership across cancelled opens and setup failures.
use super::{Session, client};
use std::ops::{Deref, DerefMut};

pub(super) struct SessionChannel(Option<russh::Channel<client::Msg>>);

impl SessionChannel {
    pub(super) fn new(channel: russh::Channel<client::Msg>) -> Self {
        Self(Some(channel))
    }

    /// Transfer cleanup to an established stream or a spawned channel loop.
    fn into_channel(mut self) -> russh::Channel<client::Msg> {
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
        let gate = self.lifecycle.session_open.clone().lock_owned().await;
        let handle = self.handle.clone();
        open_owned(gate, async move { handle.channel_open_session().await }).await
    }

    pub(super) async fn open_socket_channel(
        &self,
        open: impl Future<Output = Result<russh::Channel<client::Msg>, russh::Error>> + Send + 'static,
    ) -> Result<SessionChannel, russh::Error> {
        // Slow socket destinations must not hold up shell and command opens.
        let slot = self
            .lifecycle
            .socket_opens
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| russh::Error::Disconnect)?;
        open_owned(slot, open).await
    }
}

async fn open_owned(
    slot: impl Send + 'static,
    open: impl Future<Output = Result<russh::Channel<client::Msg>, russh::Error>> + Send + 'static,
) -> Result<SessionChannel, russh::Error> {
    let (reply, result) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        if reply.is_closed() {
            return;
        }
        // Once requested, keep the slot and await confirmation even if the caller
        // goes away. A failed delivery then drops and closes the owned channel.
        let channel = open.await.map(SessionChannel::new);
        drop(slot);
        let _ = reply.send(channel);
    });
    result.await.map_err(|_| russh::Error::Disconnect)?
}
