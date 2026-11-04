//! Unified public call creation: SDP and initial configuration travel together.
use super::super::{IO_TIMEOUT, MAX_WIRE, models};
use native_credentials::NativeCredential;
use reqwest::{
    Client,
    header::{AUTHORIZATION, HeaderValue, LOCATION},
    multipart::{Form, Part},
};
use serde_json::Value;

static HTTP: std::sync::OnceLock<Result<Client, &'static str>> = std::sync::OnceLock::new();

const CALLS: &str = "https://api.openai.com/v1/realtime/calls";
pub(super) struct Call {
    pub answer: String,
    pub id: String,
    pub client: Client,
    pub authorization: HeaderValue,
    closed: std::sync::atomic::AtomicBool,
}
impl Call {
    pub async fn create(
        key: &NativeCredential,
        offer: String,
        session: Value,
    ) -> Result<Self, &'static str> {
        // Initial configuration owns model selection for both calls and previews.
        models::selected(Some(session["model"].as_str().ok_or(models::UNSUPPORTED)?))?;
        let client = HTTP
            .get_or_init(|| {
                Client::builder()
                    .timeout(IO_TIMEOUT)
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|_| "Realtime HTTP client could not start.")
            })
            .clone()?;
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
            .post(CALLS)
            .header(AUTHORIZATION, authorization.clone())
            .multipart(form)
            .send()
            .await
            .map_err(|_| "Realtime call creation failed. Check your network.")?;
        if response.status().as_u16() != 201 {
            return Err(match response.status().as_u16() {
                401 | 403 | 404 => models::ACCESS_ERROR,
                429 => "OpenAI Realtime quota or rate limit reached.",
                _ => "OpenAI rejected the Realtime call configuration.",
            });
        }
        let id = call_id(
            response
                .headers()
                .get(LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("Realtime call identifier is missing.")?,
        )?;
        let mut call = Self {
            answer: String::new(),
            id,
            client,
            authorization,
            closed: std::sync::atomic::AtomicBool::new(false),
        };
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
        call.answer = answer;
        Ok(call)
    }
    pub async fn hangup(&self) {
        if self.closed.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return;
        }
        // Media close is always performed too; a revoked key can reject hangup.
        let _ = self
            .client
            .post(format!("{CALLS}/{}/hangup", self.id))
            .header(AUTHORIZATION, self.authorization.clone())
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await;
    }
}
pub(super) fn call_id(location: &str) -> Result<String, &'static str> {
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
        if let Ok(runtime) = crate::runtime() {
            let client = self.client.clone();
            let authorization = self.authorization.clone();
            let id = self.id.clone();
            runtime.spawn(async move {
                let _ = client
                    .post(format!("{CALLS}/{id}/hangup"))
                    .header(AUTHORIZATION, authorization)
                    .timeout(std::time::Duration::from_secs(2))
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
