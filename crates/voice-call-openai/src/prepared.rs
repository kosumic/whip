//! Optional, credential-free HTTPS preparation for both voice backends.
//!
//! Hosts enable this only while foregrounded and eligible to call. Preparation
//! uses the same HTTP pool as call creation, without creating a provider session.
use parking_lot::Mutex;
use reqwest::Client;
use std::time::Duration;
use tokio::task::JoinHandle;

const ENDPOINT: &str = "https://api.openai.com/v1/models";
const REFRESH: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
static PREPARATION: Mutex<Preparation> = Mutex::new(Preparation { task: None });

/// Start or stop best-effort HTTPS preparation on the caller's Tokio runtime.
/// Returns whether preparation could be scheduled, not whether the network is
/// reachable. Repeated enables share one worker; calls never wait for it.
pub fn configure(enabled: bool) -> bool {
    let mut preparation = PREPARATION.lock();
    if !enabled {
        preparation.stop();
        return true;
    }
    let Ok(client) = crate::api::client() else {
        return false;
    };
    preparation.start(client, ENDPOINT.to_owned(), REFRESH)
}

/// Cancel preparation, including an outstanding request. Idle pooled connections
/// may expire normally; no further refresh is scheduled until enabled again.
pub fn clear() {
    configure(false);
}

struct Preparation {
    task: Option<JoinHandle<()>>,
}

impl Preparation {
    fn start(&mut self, client: Client, endpoint: String, refresh: Duration) -> bool {
        if self.task.as_ref().is_some_and(|task| !task.is_finished()) {
            return true;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return false;
        };
        self.task = Some(runtime.spawn(async move {
            loop {
                // A failure is optional preparation, never a reason to block a
                // call or retry its authenticated session-creation request.
                let _ = warm(&client, &endpoint).await;
                tokio::time::sleep(refresh).await;
            }
        }));
        true
    }

    fn stop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Drop for Preparation {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn warm(client: &Client, endpoint: &str) -> Result<(), reqwest::Error> {
    // Reqwest has no public socket-only preconnect. An anonymous HEAD completes
    // DNS/TCP/TLS inside its actual pool. Even 401/405 responses warm the socket;
    // redirects are disabled by the shared client. Never attach authorization.
    client
        .head(endpoint)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await?
        .bytes()
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests;
