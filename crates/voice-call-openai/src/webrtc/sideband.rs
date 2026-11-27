//! Transport operations shared by both providers. Readiness, confirmation,
//! timing, error classification and close acknowledgement remain caller policy.
use crate::{recovery, socket};
use std::time::Duration;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::{Error, http::Request};

const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) async fn connect(
    request: Request<()>,
    stop: &mut watch::Receiver<bool>,
) -> Option<Result<socket::RawSocket, recovery::Failure>> {
    tokio::select! {
        biased;
        _ = stop.changed() => None,
        result = crate::connect_request(request) => Some(result),
    }
}

/// Bounded WebSocket close only. GPT-Live's session.close/session.closed exchange
/// and Realtime's REST call retirement are separate provider responsibilities.
pub(super) async fn close(socket: &mut socket::RawSocket) -> bool {
    matches!(
        tokio::time::timeout(CLOSE_TIMEOUT, futures::SinkExt::close(socket)).await,
        Ok(Ok(()) | Err(Error::ConnectionClosed | Error::AlreadyClosed))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    #[tokio::test]
    async fn cancellation_interrupts_a_pending_handshake() -> Result<(), Box<dyn std::error::Error>>
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let request = format!("ws://{}", listener.local_addr()?).into_client_request()?;
        let (stop, mut stopped) = watch::channel(false);
        let connection = tokio::spawn(async move { connect(request, &mut stopped).await });
        let (_stream, _) = listener.accept().await?;
        stop.send_replace(true);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), connection)
                .await??
                .is_none()
        );
        Ok(())
    }

    #[tokio::test]
    async fn sideband_connect_and_close_preserve_transport_results()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let request = format!("ws://{}", listener.local_addr()?).into_client_request()?;
        let (_stop, mut stopped) = watch::channel(false);
        let connection = tokio::spawn(async move { connect(request, &mut stopped).await });
        let (stream, _) = listener.accept().await?;
        let _server = tokio_tungstenite::accept_async(stream).await?;
        let mut socket = connection
            .await?
            .ok_or("cancelled")?
            .map_err(|e| e.message)?;
        assert!(close(&mut socket).await);
        Ok(())
    }

    #[tokio::test]
    async fn a_peer_initiated_close_finishes_the_sideband_handshake()
    -> Result<(), Box<dyn std::error::Error>> {
        use futures::StreamExt;
        use tokio_tungstenite::tungstenite::Message;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("ws://{}", listener.local_addr()?);
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let mut server = tokio_tungstenite::accept_async(stream).await?;
            server.close(None).await?;
            server.next().await.transpose()
        });
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await?;
        assert_eq!(socket.next().await.transpose()?, Some(Message::Close(None)));
        assert!(close(&mut socket).await);
        assert_eq!(
            tokio::time::timeout(CLOSE_TIMEOUT, peer).await???,
            Some(Message::Close(None))
        );
        Ok(())
    }

    #[tokio::test]
    async fn failed_handshake_keeps_retry_classification() -> Result<(), Box<dyn std::error::Error>>
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let request = format!("ws://{}", listener.local_addr()?).into_client_request()?;
        let (_stop, mut stopped) = watch::channel(false);
        let connection = tokio::spawn(async move { connect(request, &mut stopped).await });
        let (stream, _) = listener.accept().await?;
        drop(stream);
        let error = connection
            .await?
            .ok_or("cancelled")?
            .err()
            .ok_or("handshake succeeded")?;
        assert!(error.retryable);
        assert_eq!(
            error.message,
            "OpenAI Realtime could not connect. Check your network."
        );
        Ok(())
    }
}
