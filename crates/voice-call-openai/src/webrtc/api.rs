//! Unified public call creation: SDP and initial configuration travel together.
use crate::{IO_TIMEOUT, MAX_WIRE, models};
use reqwest::{
    Client,
    header::{AUTHORIZATION, HeaderValue, LOCATION},
    multipart::{Form, Part},
};
use serde_json::Value;

static HTTP: std::sync::OnceLock<Result<Client, &'static str>> = std::sync::OnceLock::new();

pub fn client() -> Result<Client, &'static str> {
    HTTP.get_or_init(|| {
        Client::builder()
            .timeout(IO_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Voice HTTP client could not start.")
    })
    .clone()
}

const CALLS: &str = "https://api.openai.com/v1/realtime/calls";
const CREATION_UNKNOWN: &str =
    "Realtime call creation outcome is unknown. Start a new call manually.";
pub struct Call {
    pub answer: String,
    pub id: String,
    pub client: Client,
    pub authorization: HeaderValue,
    closed: std::sync::atomic::AtomicBool,
    runtime: tokio::runtime::Handle,
}
impl Call {
    pub async fn create(
        key: &impl crate::Credential,
        offer: String,
        session: Value,
    ) -> Result<Self, &'static str> {
        // Initial configuration owns model selection for both calls and previews.
        crate::validate_model(session["model"].as_str().ok_or(models::UNSUPPORTED)?)?;
        let client = client()?;
        let mut authorization = HeaderValue::from_bytes(&key.authorization())
            .map_err(|_| "Invalid voice credential.")?;
        authorization.set_sensitive(true);
        let form = Form::new()
            .part(
                "sdp",
                Part::text(offer)
                    .mime_str("application/sdp")
                    .map_err(|_| "Invalid voice offer.")?,
            )
            .part(
                "session",
                Part::text(session.to_string())
                    .mime_str("application/json")
                    .map_err(|_| "Invalid voice session.")?,
            );
        let response = client
            .post(format!("{CALLS}?dcid={}", crate::DATA_CHANNEL_ID))
            .header(AUTHORIZATION, authorization.clone())
            .multipart(form)
            .send()
            .await
            .map_err(|_| CREATION_UNKNOWN)?;
        if response.status().as_u16() != 201 {
            return Err(match response.status().as_u16() {
                401 | 403 | 404 => models::ACCESS_ERROR,
                429 => "OpenAI Realtime quota or rate limit reached.",
                400..=499 => "OpenAI rejected the Realtime call configuration.",
                _ => CREATION_UNKNOWN,
            });
        }
        let id = call_id(
            response
                .headers()
                .get(LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or(CREATION_UNKNOWN)?,
        )
        .map_err(|_| CREATION_UNKNOWN)?;
        let mut call = Self {
            answer: String::new(),
            id,
            client,
            authorization,
            closed: std::sync::atomic::AtomicBool::new(false),
            runtime: tokio::runtime::Handle::current(),
        };
        let answer = async {
            if response
                .content_length()
                .is_some_and(|length| length > MAX_WIRE as u64)
            {
                return Err("Realtime SDP answer is too large.");
            }
            let mut response = response;
            let mut answer = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "Realtime SDP answer could not be read.")?
            {
                if answer.len() + chunk.len() > MAX_WIRE {
                    return Err("Realtime SDP answer is too large.");
                }
                answer.extend_from_slice(&chunk);
            }
            let answer = String::from_utf8(answer).map_err(|_| "Invalid Realtime SDP answer.")?;
            if !answer.starts_with("v=0") {
                return Err("Invalid Realtime SDP answer.");
            }
            Ok::<_, &'static str>(answer)
        }
        .await;
        call.answer = match answer {
            Ok(answer) => answer,
            Err(error) => {
                call.hangup().await?;
                return Err(error);
            }
        };
        Ok(call)
    }
    pub async fn hangup(&self) -> Result<(), &'static str> {
        if self.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        // Media close is always performed too; a revoked key can reject hangup.
        let response = self
            .client
            .post(format!("{CALLS}/{}/hangup", self.id))
            .header(AUTHORIZATION, self.authorization.clone())
            .timeout(super::super::recovery::HANGUP_TIMEOUT)
            .send()
            .await
            .map_err(|_| super::super::recovery::CLEANUP_FAILED)?;
        if !response.status().is_success() && !matches!(response.status().as_u16(), 404 | 410) {
            return Err(super::super::recovery::CLEANUP_FAILED);
        }
        self.closed
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    }
}
pub fn call_id(location: &str) -> Result<String, &'static str> {
    let path = location
        .strip_prefix("https://api.openai.com")
        .unwrap_or(location);
    let id = path
        .strip_prefix("/v1/realtime/calls/")
        .ok_or("Invalid Realtime call location.")?;
    if id.is_empty()
        || id.len() > 256
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("Invalid Realtime call identifier.");
    }
    Ok(id.into())
}

impl Drop for Call {
    fn drop(&mut self) {
        if self.closed.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return;
        }
        {
            let client = self.client.clone();
            let authorization = self.authorization.clone();
            let id = self.id.clone();
            self.runtime.spawn(async move {
                let _ = client
                    .post(format!("{CALLS}/{id}/hangup"))
                    .header(AUTHORIZATION, authorization)
                    .timeout(super::super::recovery::HANGUP_TIMEOUT)
                    .send()
                    .await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn call_location_cannot_redirect_authorization_or_inject_a_sideband_url()
    -> Result<(), &'static str> {
        assert_eq!(call_id("/v1/realtime/calls/rtc_test-1")?, "rtc_test-1");
        assert_eq!(
            call_id("https://api.openai.com/v1/realtime/calls/rtc_test")?,
            "rtc_test"
        );
        for invalid in [
            "https://untrusted.example/v1/realtime/calls/id",
            "/v1/realtime/calls/../id",
            "/v1/realtime/calls/id?extra=true",
            "/v1/realtime/calls/",
        ] {
            assert!(call_id(invalid).is_err());
        }
        Ok(())
    }
}
