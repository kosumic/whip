//! Streamable HTTP MCP with bounded JSON POST responses. No SSE is needed for
//! browser tools; GET explicitly reports that the server has no event stream.
use std::sync::{
    Arc, Weak,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::{Semaphore, watch};

use super::{ReverseControl, tools};

pub(super) const LATEST_PROTOCOL: &str = "2025-11-25";
pub(super) const PROTOCOLS: &[&str] = &["2025-03-26", "2025-06-18", LATEST_PROTOCOL];
const MAX_BODY: usize = 1024 * 1024;
const BODY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REQUESTS: usize = 32;
const SESSION_HEADER: &str = "mcp-session-id";
const PROTOCOL_HEADER: &str = "mcp-protocol-version";

pub(super) struct Server {
    stop: watch::Sender<bool>,
    alive: Arc<AtomicBool>,
}

impl Server {
    pub(super) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub(super) fn stopped(&self) -> watch::Receiver<bool> {
        self.stop.subscribe()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

#[derive(Clone)]
struct HttpState {
    owner: Weak<ReverseControl>,
    authority: String,
    requests: Arc<Semaphore>,
}

pub(super) fn serve(
    listener: TcpListener,
    owner: Weak<ReverseControl>,
    authority: String,
    epoch: u64,
) -> Result<Server, String> {
    let (stop, mut stopped) = watch::channel(false);
    let alive = Arc::new(AtomicBool::new(true));
    let server_alive = alive.clone();
    let state = HttpState {
        owner: owner.clone(),
        authority,
        requests: Arc::new(Semaphore::new(MAX_REQUESTS)),
    };
    let router = Router::new().fallback(handle).with_state(state);
    crate::runtime()?.spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                if !*stopped.borrow() {
                    let _ = stopped.changed().await;
                }
            })
            .await;
        server_alive.store(false, Ordering::Release);
        if let Some(owner) = owner.upgrade() {
            owner.shutdown_bridge(epoch);
        }
    });
    Ok(Server { stop, alive })
}

fn error(status: StatusCode) -> Response {
    // Never reflect URLs, credentials, page content or request arguments.
    status.into_response()
}

fn session_header_matches(headers: &HeaderMap, session: &str) -> bool {
    headers
        .get(SESSION_HEADER)
        .is_some_and(|value| value == session)
}

fn protocol_valid(headers: &HeaderMap, negotiated: Option<&str>) -> bool {
    headers.get(PROTOCOL_HEADER).is_none_or(|header| {
        header.to_str().is_ok_and(|value| {
            PROTOCOLS.contains(&value) && negotiated.is_none_or(|protocol| value == protocol)
        })
    })
}

fn valid_message(message: &Value) -> bool {
    message.is_object()
        && message["jsonrpc"] == "2.0"
        && message["method"].is_string()
        && message
            .get("id")
            .is_none_or(|id| id.is_string() || id.as_i64().is_some() || id.as_u64().is_some())
}

async fn handle(State(state): State<HttpState>, request: Request) -> Response {
    let Ok(_permit) = state.requests.try_acquire_owned() else {
        return error(StatusCode::SERVICE_UNAVAILABLE);
    };
    let Some(owner) = state.owner.upgrade() else {
        return error(StatusCode::SERVICE_UNAVAILABLE);
    };
    let (parts, body) = request.into_parts();
    // CLI callers have no Origin. Browser-origin requests are never authorized,
    // even if a page guesses the loopback port (including DNS rebinding).
    if parts.headers.contains_key(header::ORIGIN) {
        return error(StatusCode::FORBIDDEN);
    }
    if [
        header::HOST.as_str(),
        header::AUTHORIZATION.as_str(),
        SESSION_HEADER,
        PROTOCOL_HEADER,
    ]
    .iter()
    .any(|name| parts.headers.get_all(*name).iter().count() > 1)
    {
        return error(StatusCode::BAD_REQUEST);
    }
    if parts
        .headers
        .get(header::HOST)
        .is_none_or(|host| host != state.authority.as_str())
    {
        return error(StatusCode::FORBIDDEN);
    }
    let Some(session) = parts
        .uri
        .path()
        .strip_prefix("/mcp/")
        .filter(|id| !id.is_empty() && !id.contains('/'))
    else {
        return error(StatusCode::NOT_FOUND);
    };
    if parts.uri.query().is_some() {
        return error(StatusCode::BAD_REQUEST);
    }
    let Some(authorization) = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return error(StatusCode::UNAUTHORIZED);
    };
    let Some(authenticated) = owner.authenticate(session, authorization) else {
        return error(if owner.sessions.lock().contains_key(session) {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::NOT_FOUND
        });
    };
    let protocol = authenticated.protocol;
    if !protocol_valid(&parts.headers, protocol.as_deref()) {
        return error(StatusCode::BAD_REQUEST);
    }
    if parts.method == Method::GET {
        return method_not_allowed();
    }
    if parts.method == Method::DELETE {
        if !session_header_matches(&parts.headers, session) || protocol.is_none() {
            return error(StatusCode::BAD_REQUEST);
        }
        owner.close_session(session);
        return StatusCode::OK.into_response();
    }
    if parts.method != Method::POST {
        return method_not_allowed();
    }
    let json_content = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
        });
    if !json_content {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let accepts_json = parts
        .headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|media| {
                media.split(';').next().unwrap_or_default().trim() == "application/json"
            })
        });
    if !accepts_json {
        return error(StatusCode::NOT_ACCEPTABLE);
    }
    let bytes = match tokio::time::timeout(BODY_TIMEOUT, to_bytes(body, MAX_BODY)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return error(StatusCode::PAYLOAD_TOO_LARGE),
        Err(_) => return error(StatusCode::REQUEST_TIMEOUT),
    };
    let Ok(message) = serde_json::from_slice::<Value>(&bytes) else {
        return error(StatusCode::BAD_REQUEST);
    };
    if !valid_message(&message) {
        return error(StatusCode::BAD_REQUEST);
    }
    let initialize = message["method"] == "initialize";
    if initialize {
        if message.get("id").is_none()
            || parts
                .headers
                .get(SESSION_HEADER)
                .is_some_and(|header| header != session)
        {
            return error(StatusCode::BAD_REQUEST);
        }
    } else if protocol.is_none() || !session_header_matches(&parts.headers, session) {
        return error(StatusCode::BAD_REQUEST);
    }
    // Revocation during a slow body read must also take effect on this request.
    if owner.authenticate(session, authorization).is_none() {
        return error(StatusCode::NOT_FOUND);
    }
    let Some(mut result) = owner.request(session, &message).await else {
        return StatusCode::ACCEPTED.into_response();
    };
    // Expose the authenticated host-side connection to the agent, including
    // clients that surface tool descriptions but omit server instructions.
    if let Some(payload) = result.get_mut("result") {
        let instructions = if initialize {
            payload.get_mut("instructions")
        } else if message["method"] == "tools/list" {
            payload["tools"].as_array_mut().and_then(|catalog| {
                catalog
                    .iter_mut()
                    .find(|tool| tool["name"] == tools::SCRIPT_DISCOVERY_TOOL)
                    .and_then(|tool| tool.get_mut("description"))
            })
        } else {
            None
        };
        if let Some(instructions) = instructions {
            // Initialization may negotiate a version different from the request.
            let Some(negotiated) = owner.authenticate(session, authorization) else {
                return error(StatusCode::NOT_FOUND);
            };
            let Some(protocol) = negotiated.protocol else {
                return error(StatusCode::INTERNAL_SERVER_ERROR);
            };
            let Ok(script) =
                tools::script_instructions(&state.authority, session, authorization, &protocol)
            else {
                return error(StatusCode::INTERNAL_SERVER_ERROR);
            };
            *instructions = Value::String(format!(
                "{}\n\n{script}",
                instructions.as_str().unwrap_or_default()
            ));
        }
    }
    let mut response = Json(result).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if initialize {
        let Ok(value) = HeaderValue::from_str(session) else {
            return error(StatusCode::INTERNAL_SERVER_ERROR);
        };
        response.headers_mut().insert(SESSION_HEADER, value);
    }
    response
}

fn method_not_allowed() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST, DELETE")],
        Body::empty(),
    )
        .into_response()
}
