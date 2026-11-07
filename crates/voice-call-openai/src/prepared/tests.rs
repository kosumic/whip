use super::*;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::mpsc,
    task::JoinSet,
    time::timeout,
};

type Error = Box<dyn std::error::Error + Send + Sync>;
const DEADLINE: Duration = Duration::from_secs(3);
const TEST_AUTHORIZATION: &str = "Bearer local-test-only";

struct Dns {
    address: SocketAddr,
    lookups: AtomicUsize,
}

impl Resolve for Dns {
    fn resolve(&self, name: Name) -> Resolving {
        assert_eq!(name.as_str(), "voice.test");
        self.lookups.fetch_add(1, Ordering::SeqCst);
        let addresses: Addrs = Box::new([self.address].into_iter());
        Box::pin(std::future::ready(Ok(addresses)))
    }
}

#[derive(Clone, Copy)]
enum Behavior {
    KeepAlive,
    CloseAfterHead,
    StallHead,
}

#[derive(Debug)]
struct Request {
    connection: usize,
    method: String,
    path: String,
    authorization: Option<String>,
}

struct Server {
    origin: String,
    client: Client,
    dns: Arc<Dns>,
    requests: mpsc::UnboundedReceiver<Request>,
    closed: mpsc::UnboundedReceiver<()>,
    task: JoinHandle<()>,
}

impl Server {
    async fn new(behavior: Behavior) -> Result<Self, Error> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["voice.test".to_owned()])?;
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into(),
        )?;
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let dns = Arc::new(Dns {
            address,
            lookups: AtomicUsize::new(0),
        });
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(DEADLINE)
            .dns_resolver(dns.clone())
            .add_root_certificate(reqwest::Certificate::from_der(cert.der())?)
            .build()?;
        let (requests, request_rx) = mpsc::unbounded_channel();
        let (closed, closed_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            let mut count = 0;
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break; };
                        count += 1;
                        let acceptor = acceptor.clone();
                        let requests = requests.clone();
                        let closed = closed.clone();
                        connections.spawn(async move {
                            let stream = acceptor.accept(stream).await?;
                            serve(stream, count, behavior, requests, closed).await
                        });
                    }
                    Some(result) = connections.join_next(), if !connections.is_empty() => {
                        result.expect("test HTTPS handler panicked").expect("test HTTPS handler failed");
                    }
                }
            }
        });
        Ok(Self {
            origin: format!("https://voice.test:{}", address.port()),
            client,
            dns,
            requests: request_rx,
            closed: closed_rx,
            task,
        })
    }

    fn endpoint(&self) -> String {
        format!("{}/v1/models", self.origin)
    }

    async fn request(&mut self) -> Result<Request, Error> {
        timeout(DEADLINE, self.requests.recv())
            .await?
            .ok_or_else(|| "HTTPS server stopped".into())
    }

    async fn call(&self, path: &str) -> Result<(), Error> {
        let response = self
            .client
            .clone()
            .post(format!("{}{path}", self.origin))
            .header(reqwest::header::AUTHORIZATION, TEST_AUTHORIZATION)
            .send()
            .await?;
        assert_eq!(response.status(), 201);
        response.bytes().await?;
        Ok(())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve(
    stream: tokio_rustls::server::TlsStream<tokio::net::TcpStream>,
    connection: usize,
    behavior: Behavior,
    requests: mpsc::UnboundedSender<Request>,
    closed: mpsc::UnboundedSender<()>,
) -> Result<(), Error> {
    let mut stream = BufReader::new(stream);
    loop {
        let mut line = String::new();
        if stream.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().ok_or("Missing method")?.to_owned();
        let path = parts.next().ok_or("Missing path")?.to_owned();
        let mut authorization = None;
        let mut content_length = 0;
        loop {
            line.clear();
            if stream.read_line(&mut line).await? == 0 {
                return Err("Incomplete request headers".into());
            }
            if line == "\r\n" {
                break;
            }
            let (name, value) = line.split_once(':').ok_or("Invalid header")?;
            if name.eq_ignore_ascii_case("authorization") {
                authorization = Some(value.trim().to_owned());
            } else if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse()?;
            }
        }
        stream.read_exact(&mut vec![0; content_length]).await?;
        let head = method == "HEAD";
        requests.send(Request {
            connection,
            method,
            path,
            authorization,
        })?;
        if head && matches!(behavior, Behavior::StallHead) {
            // Cancellation must close an in-flight request, not just its timer.
            let mut byte = [0];
            let _ = stream.read(&mut byte).await;
            closed.send(())?;
            return Ok(());
        }
        let close = head && matches!(behavior, Behavior::CloseAfterHead);
        let status = if head {
            "401 Unauthorized"
        } else {
            "201 Created"
        };
        let connection = if close { "close" } else { "keep-alive" };
        stream
            .get_mut()
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: {connection}\r\n\r\n"
                )
                .as_bytes(),
            )
            .await?;
        stream.get_mut().flush().await?;
        if close {
            stream.get_mut().shutdown().await?;
            return Ok(());
        }
    }
}

#[tokio::test]
async fn anonymous_head_prepares_dns_tcp_tls_for_both_session_routes() -> Result<(), Error> {
    let mut server = Server::new(Behavior::KeepAlive).await?;
    warm(&server.client, &server.endpoint()).await?;
    let first = server.request().await?;
    assert_eq!(first.method, "HEAD");
    assert_eq!(first.path, "/v1/models");
    assert!(first.authorization.is_none());
    for path in ["/v1/realtime/calls", "/v1/live/sessions"] {
        server.call(path).await?;
        let call = server.request().await?;
        assert_eq!(call.method, "POST");
        assert_eq!(call.path, path);
        assert_eq!(call.authorization.as_deref(), Some(TEST_AUTHORIZATION));
        assert_eq!(call.connection, first.connection);
    }
    warm(&server.client, &server.endpoint()).await?;
    let refresh = server.request().await?;
    assert_eq!(refresh.connection, first.connection);
    assert!(refresh.authorization.is_none());
    assert_eq!(server.dns.lookups.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn expired_prepared_connection_does_not_prevent_a_call() -> Result<(), Error> {
    let mut server = Server::new(Behavior::CloseAfterHead).await?;
    warm(&server.client, &server.endpoint()).await?;
    let head = server.request().await?;
    server.call("/v1/live/sessions").await?;
    assert_ne!(server.request().await?.connection, head.connection);
    assert_eq!(server.dns.lookups.load(Ordering::SeqCst), 2);
    Ok(())
}

#[tokio::test]
async fn one_worker_refreshes_until_disabled_and_can_restart() -> Result<(), Error> {
    let mut server = Server::new(Behavior::KeepAlive).await?;
    let mut preparation = Preparation { task: None };
    let refresh = Duration::from_millis(100);
    assert!(preparation.start(server.client.clone(), server.endpoint(), refresh));
    assert_eq!(server.request().await?.method, "HEAD");
    assert!(preparation.start(server.client.clone(), server.endpoint(), refresh));
    // Enabling twice must not start a second immediate request.
    assert!(
        timeout(Duration::from_millis(30), server.requests.recv())
            .await
            .is_err()
    );
    assert_eq!(server.request().await?.method, "HEAD");
    preparation.stop();
    assert!(timeout(refresh * 2, server.requests.recv()).await.is_err());
    assert!(preparation.start(server.client.clone(), server.endpoint(), refresh));
    assert_eq!(server.request().await?.method, "HEAD");
    preparation.stop();
    Ok(())
}

#[tokio::test]
async fn calls_do_not_wait_for_preparation_and_disabling_cancels_it() -> Result<(), Error> {
    let mut server = Server::new(Behavior::StallHead).await?;
    let mut preparation = Preparation { task: None };
    assert!(preparation.start(server.client.clone(), server.endpoint(), REFRESH));
    let head = server.request().await?;
    assert_eq!(head.method, "HEAD");
    server.call("/v1/realtime/calls").await?;
    let call = server.request().await?;
    assert_eq!(call.method, "POST");
    assert_ne!(call.connection, head.connection);
    preparation.stop();
    timeout(DEADLINE, server.closed.recv())
        .await?
        .ok_or("Socket remained open")?;
    Ok(())
}
