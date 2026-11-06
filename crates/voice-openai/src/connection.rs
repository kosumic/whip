use crate::{IO_TIMEOUT, MAX_WIRE, models, recovery, socket};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig};
pub async fn connect_raw(
    key: &impl crate::Credential,
    url: &str,
) -> Result<socket::RawSocket, &'static str> {
    connect_request(authorized_request(key, url)?)
        .await
        .map_err(|error| error.message)
}

pub fn authorized_request(
    key: &impl crate::Credential,
    url: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, &'static str> {
    let mut request = url
        .into_client_request()
        .map_err(|_| "Realtime request could not be prepared.")?;
    let header = key.authorization();
    let mut authorization = tokio_tungstenite::tungstenite::http::HeaderValue::from_bytes(&header)
        .map_err(|_| "Invalid OpenAI API credential.")?;
    authorization.set_sensitive(true);
    request.headers_mut().insert("Authorization", authorization);
    drop(header);
    Ok(request)
}

pub async fn connect_request(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
) -> Result<socket::RawSocket, recovery::Failure> {
    let socket_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_WIRE))
        .max_frame_size(Some(MAX_WIRE));
    let (socket, _) = tokio::time::timeout(
        IO_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(socket_config), false),
    )
    .await
    .map_err(|_| recovery::Failure {
        message: "OpenAI Realtime connection timed out.",
        retryable: true,
    })?
    .map_err(|error| match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            recovery::Failure::from(match response.status().as_u16() {
                401 | 403 | 404 => models::ACCESS_ERROR,
                429 => "OpenAI Realtime quota or rate limit reached.",
                _ => "OpenAI Realtime could not connect. Check model access and connectivity.",
            })
        }
        _ => recovery::Failure {
            message: "OpenAI Realtime could not connect. Check your network.",
            retryable: true,
        },
    })?;
    Ok(socket)
}
