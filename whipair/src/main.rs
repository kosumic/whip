mod authorized_keys;
mod network;
mod protocol;

use std::{
    io::{self, IsTerminal, Read as _, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use clap::{Parser, Subcommand};
use qrcode::{EcLevel, QrCode, render::unicode};
use rand::{RngCore, rngs::OsRng};
use russh::{
    ChannelMsg, client,
    keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate},
};
use sha2::{Digest, Sha256};
use ssh_key::{PrivateKey, PublicKey, private::Ed25519Keypair};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    time::{Instant, timeout, timeout_at},
};

use crate::{
    authorized_keys::{
        AppendOutcome, append_authorized_key, default_authorized_keys_path, remove_authorized_key,
    },
    network::{AddressSelection, discover_address_candidates, select_address},
    protocol::{
        EnrollmentRequest, EnrollmentResponse, PairingPayload, decode_pairing_code,
        encode_pairing_code, fingerprint_public_key, validate_public_key,
        verification_code_public_key,
    },
};

const DEFAULT_TTL_SECONDS: u64 = 120;
const DEFAULT_SSH_PORT: u16 = 22;
const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Prepare a one-shot SSH pairing credential and display its QR code.
    Serve(ServeArgs),
    /// Development client: submit a public key using a copied pairing code.
    Request(RequestArgs),
    /// Decode and print a copied pairing code.
    Inspect { code: String },
    /// Relay a forced SSH command to the local approval process.
    #[command(hide = true)]
    Exchange(ExchangeArgs),
}

#[derive(Debug, clap::Args)]
struct ServeArgs {
    /// SSH hostname or address Whip should use. Without this, an interactive selector is shown.
    #[arg(long)]
    advertise_host: Option<String>,
    /// Port of the existing SSH service to advertise. Defaults to 22.
    #[arg(long)]
    ssh_port: Option<u16>,
    /// SSH account to pair. It must be the current local user.
    #[arg(long)]
    ssh_user: Option<String>,
    /// Override SSH host-key discovery (primarily useful for prototypes/tests).
    #[arg(long)]
    ssh_fingerprint: Option<String>,
    #[arg(long, default_value_t = DEFAULT_TTL_SECONDS)]
    ttl: u64,
    #[arg(long)]
    authorized_keys: Option<PathBuf>,
    /// Skip the terminal approval prompt. Intended only for automated tests.
    #[arg(long, hide = true)]
    yes: bool,
    /// Print the pairing envelope as text in addition to the QR.
    #[arg(long)]
    print_code: bool,
    /// Write the pairing envelope to a new mode-0600 file. Intended for tests.
    #[arg(long, hide = true)]
    code_output: Option<PathBuf>,
}

#[derive(Debug, clap::Args)]
struct RequestArgs {
    /// Pairing envelope copied from the host.
    #[arg(long)]
    code: String,
    /// OpenSSH public-key file to enroll.
    #[arg(long)]
    public_key: PathBuf,
    #[arg(long, default_value = "Whip prototype")]
    device_name: String,
}

#[derive(Debug, clap::Args)]
struct ExchangeArgs {
    #[arg(long)]
    socket: PathBuf,
}

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Protocol(#[from] protocol::ProtocolError),
    #[error("SSH error: {0}")]
    Ssh(#[from] russh::Error),
    #[error("SSH key error: {0}")]
    SshKey(#[from] ssh_key::Error),
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Error> {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Commands::Serve(ServeArgs {
        advertise_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_fingerprint: None,
        ttl: DEFAULT_TTL_SECONDS,
        authorized_keys: None,
        yes: false,
        print_code: false,
        code_output: None,
    })) {
        Commands::Serve(args) => serve(args).await,
        Commands::Request(args) => request(args).await,
        Commands::Exchange(args) => exchange(args).await,
        Commands::Inspect { code } => inspect(&code),
    }
}

fn inspect(code: &str) -> Result<(), Error> {
    let payload = decode_pairing_code(code)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "version": 4,
            "ssh_host": payload.ssh_host,
            "ssh_port": payload.ssh_port,
            "ssh_user": payload.ssh_user,
            "temporary_private_key_seed": "<redacted>",
            "ssh_host_key_sha256": STANDARD_NO_PAD.encode(payload.ssh_host_key_sha256),
        }))?
    );
    Ok(())
}

async fn serve(args: ServeArgs) -> Result<(), Error> {
    if args.ttl == 0 || args.ttl > 600 {
        return Err(Error::Message(
            "--ttl must be between 1 and 600 seconds".into(),
        ));
    }
    if !args.yes && !io::stdin().is_terminal() {
        return Err(Error::Message(
            "pairing approval requires a terminal; run whipair interactively".into(),
        ));
    }

    let interactive_setup = args.advertise_host.is_none();
    let selected = choose_advertised_endpoint(args.advertise_host)?;
    let ssh_port = match args.ssh_port {
        Some(port) => validate_ssh_port(port)?,
        None if interactive_setup => prompt_ssh_port()?,
        None => DEFAULT_SSH_PORT,
    };
    let ssh_host = selected.host.clone();
    let local_user = current_username();
    let ssh_user = args.ssh_user.unwrap_or_else(|| local_user.clone());
    if ssh_user != local_user {
        return Err(Error::Message(format!(
            "--ssh-user must be the current local user ({local_user})"
        )));
    }
    let fingerprint = match args.ssh_fingerprint {
        Some(value) => validate_ssh_fingerprint(&value)?,
        None => discover_ssh_fingerprint(&ssh_host, ssh_port)?,
    };
    let ssh_host_key_sha256 = decode_ssh_fingerprint(&fingerprint)?;

    let mut temporary_private_key_seed = [0_u8; 32];
    OsRng.fill_bytes(&mut temporary_private_key_seed);
    let mut temporary_private_key = temporary_private_key(&temporary_private_key_seed);
    temporary_private_key.set_comment("whipair temporary credential");

    let exchange_directory = tempfile::Builder::new().prefix("whipair-").tempdir()?;
    let socket_path = exchange_directory.path().join("exchange.sock");
    let listener = UnixListener::bind(&socket_path)?;
    let forced_command = forced_command(&socket_path)?;
    let temporary_line = temporary_authorized_key_line(&temporary_private_key, &forced_command)?;
    let authorized_keys = args
        .authorized_keys
        .unwrap_or(default_authorized_keys_path()?);
    if append_authorized_key(&authorized_keys, &temporary_line)? != AppendOutcome::Added {
        return Err(Error::Message(
            "the generated temporary key unexpectedly already exists".into(),
        ));
    }
    let mut temporary_authorization =
        TemporaryAuthorization::new(authorized_keys.clone(), temporary_line);

    let payload = PairingPayload {
        ssh_host,
        ssh_port,
        ssh_user,
        temporary_private_key_seed,
        ssh_host_key_sha256,
    };
    let code = encode_pairing_code(&payload)?;
    if let Some(path) = args.code_output.as_deref() {
        write_secret_file(path, &code)?;
    }
    let deadline = Instant::now() + Duration::from_secs(args.ttl);
    let expires_at = unix_seconds()? + args.ttl;
    print_pairing_screen(&selected, &payload, expires_at, &code, args.print_code)?;

    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);
    let outcome = loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                match timeout_at(
                    deadline,
                    handle_exchange(stream, &authorized_keys, args.yes, deadline),
                ).await {
                    Ok(Ok(ExchangeOutcome::Enrolled)) => break Ok(()),
                    Ok(Ok(ExchangeOutcome::Ignored)) => {}
                    Ok(Err(error)) => eprintln!("ignored pairing exchange: {error}"),
                    Err(_) => break Err(Error::Message("pairing code expired".into())),
                }
            }
            _ = timeout_at(deadline, std::future::pending::<()>()) => {
                break Err(Error::Message("pairing code expired".into()));
            }
            result = &mut shutdown => {
                result?;
                println!("\nPairing cancelled.");
                break Ok(());
            }
        }
    };

    if let Err(error) = temporary_authorization.cleanup() {
        eprintln!(
            "warning: could not remove the restricted temporary key from {}: {error}",
            authorized_keys.display()
        );
    }
    drop(exchange_directory);
    outcome
}

#[derive(Debug, Eq, PartialEq)]
enum ExchangeOutcome {
    Enrolled,
    Ignored,
}

async fn handle_exchange(
    stream: UnixStream,
    authorized_keys: &Path,
    assume_yes: bool,
    deadline: Instant,
) -> Result<ExchangeOutcome, Error> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let request_bytes = timeout(CONNECT_TIMEOUT, read_bounded_line(&mut reader))
        .await
        .map_err(|_| Error::Message("pairing request timed out".into()))??;
    let request: EnrollmentRequest = match serde_json::from_slice(&request_bytes) {
        Ok(request) => request,
        Err(_) => {
            send_response(
                &mut writer,
                &EnrollmentResponse::error("invalid_request", "request is not valid JSON"),
            )
            .await?;
            return Ok(ExchangeOutcome::Ignored);
        }
    };
    if Instant::now() >= deadline {
        send_response(
            &mut writer,
            &EnrollmentResponse::error("expired", "pairing code expired"),
        )
        .await?;
        return Ok(ExchangeOutcome::Ignored);
    }

    let public_key = match validate_public_key(&request.public_key) {
        Ok(key) => key,
        Err(error) => {
            send_response(
                &mut writer,
                &EnrollmentResponse::error("invalid_key", &error.to_string()),
            )
            .await?;
            return Ok(ExchangeOutcome::Ignored);
        }
    };
    let fingerprint = fingerprint_public_key(&public_key);
    let verification_code = verification_code_public_key(&public_key)?;
    let device_name = printable_device_name(&request.device_name);
    println!("\n{device_name} wants SSH access.");
    println!("Verify: {verification_code}");

    let approved = if assume_yes {
        true
    } else {
        if Instant::now() >= deadline {
            send_expired_response(&mut writer).await?;
            return Ok(ExchangeOutcome::Ignored);
        }
        let approval_deadline = deadline.into_std();
        let approval = tokio::task::spawn_blocking(move || confirm_enrollment(approval_deadline));
        let decision = match timeout_at(deadline, approval).await {
            Ok(result) => result
                .map_err(|error| Error::Message(format!("approval task failed: {error}")))??,
            Err(_) => {
                send_expired_response(&mut writer).await?;
                return Ok(ExchangeOutcome::Ignored);
            }
        };
        match decision {
            Some(approved) => approved,
            None => {
                send_expired_response(&mut writer).await?;
                return Ok(ExchangeOutcome::Ignored);
            }
        }
    };
    if !approved {
        send_response(
            &mut writer,
            &EnrollmentResponse::error("rejected", "the host user rejected enrollment"),
        )
        .await?;
        println!("Enrollment rejected.");
        return Ok(ExchangeOutcome::Ignored);
    }
    if Instant::now() >= deadline {
        send_expired_response(&mut writer).await?;
        return Ok(ExchangeOutcome::Ignored);
    }

    let outcome = append_authorized_key(authorized_keys, public_key.canonical_line())?;
    send_response(
        &mut writer,
        &EnrollmentResponse::approved(&fingerprint, outcome == AppendOutcome::AlreadyPresent),
    )
    .await?;
    println!(
        "{} {}",
        if outcome == AppendOutcome::Added {
            "Added key to"
        } else {
            "Key already present in"
        },
        authorized_keys.display()
    );
    println!("Pairing stopped.");
    Ok(ExchangeOutcome::Enrolled)
}

async fn exchange(args: ExchangeArgs) -> Result<(), Error> {
    let mut request = Vec::new();
    io::stdin()
        .take((MAX_MESSAGE_BYTES + 1) as u64)
        .read_to_end(&mut request)?;
    let valid_request = request.len() <= MAX_MESSAGE_BYTES
        && request
            .strip_suffix(b"\n")
            .is_some_and(|payload| serde_json::from_slice::<EnrollmentRequest>(payload).is_ok());
    if !valid_request {
        return Err(Error::Message(
            "expected one bounded enrollment request on stdin".into(),
        ));
    }

    let mut stream = timeout(CONNECT_TIMEOUT, UnixStream::connect(&args.socket))
        .await
        .map_err(|_| Error::Message("local pairing process connection timed out".into()))??;
    stream.write_all(&request).await?;
    stream.shutdown().await?;
    let mut reader = BufReader::new(stream);
    let response = timeout(APPROVAL_TIMEOUT, read_bounded_line(&mut reader))
        .await
        .map_err(|_| Error::Message("host approval timed out".into()))??;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&response)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

async fn request(args: RequestArgs) -> Result<(), Error> {
    let payload = decode_pairing_code(&args.code)?;
    let public_key_text = std::fs::read_to_string(&args.public_key)?;
    let public_key = validate_public_key(&public_key_text)?;
    let result = pair_over_ssh(
        &payload,
        &EnrollmentRequest {
            device_name: args.device_name,
            public_key: public_key.canonical_line().to_owned(),
        },
    )
    .await?;
    if !result.response.approved {
        return Err(refusal_error(&result.response));
    }
    println!(
        "Enrollment approved: {}",
        result
            .response
            .fingerprint
            .as_deref()
            .unwrap_or("unknown fingerprint")
    );
    println!(
        "SSH profile: {}@{}:{}",
        payload.ssh_user, payload.ssh_host, payload.ssh_port
    );
    Ok(())
}

struct PairingResult {
    response: EnrollmentResponse,
}

async fn pair_over_ssh(
    payload: &PairingPayload,
    request: &EnrollmentRequest,
) -> Result<PairingResult, Error> {
    let accepted_host_key = Arc::new(Mutex::new(None));
    let handler = PinnedSshHostKey {
        expected_sha256: payload.ssh_host_key_sha256,
        accepted_public_key: accepted_host_key.clone(),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let mut handle = timeout(
        CONNECT_TIMEOUT,
        client::connect(
            config,
            (payload.ssh_host.as_str(), payload.ssh_port),
            handler,
        ),
    )
    .await
    .map_err(|_| Error::Message("SSH pairing connection timed out".into()))??;

    let private_key = Arc::new(temporary_private_key(&payload.temporary_private_key_seed));
    let authentication = handle
        .authenticate_publickey(
            &payload.ssh_user,
            PrivateKeyWithHashAlg::new(private_key, None),
        )
        .await?;
    if !authentication.success() {
        return Err(Error::Message(
            "the restricted temporary SSH key was not accepted".into(),
        ));
    }

    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, "whipair").await?;
    let mut encoded = serde_json::to_vec(request)?;
    encoded.push(b'\n');
    channel.data(encoded.as_slice()).await?;
    channel.eof().await?;

    let (stdout, stderr, exit_status) = timeout(APPROVAL_TIMEOUT, async {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => append_bounded(&mut stdout, &data)?,
                ChannelMsg::ExtendedData { data, ext: 1 } => append_bounded(&mut stderr, &data)?,
                ChannelMsg::ExitStatus { exit_status: value } => exit_status = Some(value),
                _ => {}
            }
        }
        Ok::<_, Error>((stdout, stderr, exit_status))
    })
    .await
    .map_err(|_| Error::Message("host approval timed out".into()))??;
    if exit_status.is_some_and(|status| status != 0) {
        return Err(Error::Message(format!(
            "restricted pairing command failed: {}",
            String::from_utf8_lossy(&stderr).trim()
        )));
    }
    let response: EnrollmentResponse = serde_json::from_slice(trim_line_ending(&stdout))?;
    accepted_host_key
        .lock()
        .ok()
        .and_then(|key| key.clone())
        .ok_or_else(|| Error::Message("SSH server did not present a host key".into()))?;
    Ok(PairingResult { response })
}

#[derive(Clone)]
struct PinnedSshHostKey {
    expected_sha256: [u8; 32],
    accepted_public_key: Arc<Mutex<Option<String>>>,
}

impl PinnedSshHostKey {
    fn verify_server_key(&self, server_public_key: &PublicKey) -> Result<bool, Error> {
        let encoded = server_public_key.to_bytes()?;
        let actual: [u8; 32] = Sha256::digest(&encoded).into();
        if actual != self.expected_sha256 {
            return Err(Error::Message(
                "SSH host key did not match the fingerprint pinned in the QR code".into(),
            ));
        }
        if let Ok(mut accepted) = self.accepted_public_key.lock() {
            *accepted = Some(server_public_key.to_openssh()?);
        }
        Ok(true)
    }
}

impl client::Handler for PinnedSshHostKey {
    type Error = Error;

    fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        std::future::ready(match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => self.verify_server_key(key),
            PublicKeyOrCertificate::Certificate(_) => Err(Error::Message(
                "SSH host certificates are not supported for QR pairing".into(),
            )),
        })
    }
}

fn append_bounded(destination: &mut Vec<u8>, source: &[u8]) -> Result<(), Error> {
    if destination.len().saturating_add(source.len()) > MAX_MESSAGE_BYTES {
        return Err(Error::Message(
            "restricted pairing command returned too much data".into(),
        ));
    }
    destination.extend_from_slice(source);
    Ok(())
}

fn trim_line_ending(bytes: &[u8]) -> &[u8] {
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    bytes.strip_suffix(b"\r").unwrap_or(bytes)
}

fn refusal_error(response: &EnrollmentResponse) -> Error {
    Error::Message(format!(
        "enrollment refused ({}): {}",
        response.code.as_deref().unwrap_or("unknown"),
        response.message.as_deref().unwrap_or("no detail")
    ))
}

async fn read_bounded_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    let read = reader.read_until(b'\n', &mut bytes).await?;
    if read == 0 || bytes.len() > MAX_MESSAGE_BYTES || bytes.last() != Some(&b'\n') {
        return Err(Error::Message("expected one bounded JSON line".into()));
    }
    bytes.pop();
    Ok(bytes)
}

async fn send_response<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    response: &EnrollmentResponse,
) -> Result<(), Error> {
    let mut encoded = serde_json::to_vec(response)?;
    encoded.push(b'\n');
    writer.write_all(&encoded).await?;
    writer.shutdown().await?;
    Ok(())
}

async fn send_expired_response<W: AsyncWriteExt + Unpin>(writer: &mut W) -> Result<(), Error> {
    send_response(
        writer,
        &EnrollmentResponse::error("expired", "pairing code expired"),
    )
    .await
}

fn temporary_private_key(seed: &[u8; 32]) -> PrivateKey {
    Ed25519Keypair::from_seed(seed).into()
}

fn forced_command(socket_path: &Path) -> Result<String, Error> {
    let executable = std::env::current_exe()?;
    Ok(format!(
        "{} exchange --socket {}",
        shell_quote(&executable)?,
        shell_quote(socket_path)?
    ))
}

fn shell_quote(path: &Path) -> Result<String, Error> {
    let value = path
        .to_str()
        .ok_or_else(|| Error::Message("pairing paths must be valid UTF-8".into()))?;
    if value.contains(['\n', '\r', '\0']) {
        return Err(Error::Message("pairing path contains control data".into()));
    }
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}

fn temporary_authorized_key_line(private_key: &PrivateKey, command: &str) -> Result<String, Error> {
    let escaped_command = command.replace('\\', "\\\\").replace('"', "\\\"");
    let public_key = private_key.public_key().to_openssh()?;
    Ok(format!(
        "restrict,command=\"{escaped_command}\" {public_key} whipair-temporary"
    ))
}

struct TemporaryAuthorization {
    path: PathBuf,
    line: String,
    active: bool,
}

impl TemporaryAuthorization {
    fn new(path: PathBuf, line: String) -> Self {
        Self {
            path,
            line,
            active: true,
        }
    }

    fn cleanup(&mut self) -> io::Result<()> {
        if self.active {
            remove_authorized_key(&self.path, &self.line)?;
            self.active = false;
        }
        Ok(())
    }
}

impl Drop for TemporaryAuthorization {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            eprintln!(
                "warning: could not remove temporary pairing key from {}: {error}",
                self.path.display()
            );
        }
    }
}

struct AdvertisedEndpoint {
    label: String,
    source: String,
    host: String,
}

fn choose_advertised_endpoint(explicit: Option<String>) -> Result<AdvertisedEndpoint, Error> {
    if let Some(host) = explicit {
        return Ok(AdvertisedEndpoint {
            label: "Specified".into(),
            source: "--advertise-host".into(),
            host: validate_advertised_host(&host)?,
        });
    }
    let candidates = discover_address_candidates()?;
    match select_address(&candidates).map_err(Error::Message)? {
        AddressSelection::Discovered(candidate) => Ok(AdvertisedEndpoint {
            label: candidate.label,
            source: candidate.interface,
            host: candidate.address.to_string(),
        }),
        AddressSelection::Other => Ok(AdvertisedEndpoint {
            label: "Public/other".into(),
            source: "manual".into(),
            host: prompt_advertised_host()?,
        }),
    }
}

fn prompt_advertised_host() -> Result<String, Error> {
    eprint!("Public IP or hostname: ");
    io::stderr().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    validate_advertised_host(&answer)
}

fn validate_advertised_host(value: &str) -> Result<String, Error> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 253
        || !value.is_ascii()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(Error::Message(
            "SSH hostname must be printable ASCII without whitespace".into(),
        ));
    }
    Ok(value.into())
}

fn prompt_ssh_port() -> Result<u16, Error> {
    eprint!("SSH port [{DEFAULT_SSH_PORT}]: ");
    io::stderr().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    parse_prompted_ssh_port(&answer)
}

fn parse_prompted_ssh_port(answer: &str) -> Result<u16, Error> {
    let answer = answer.trim();
    if answer.is_empty() {
        return Ok(DEFAULT_SSH_PORT);
    }
    let port = answer
        .parse::<u16>()
        .map_err(|_| Error::Message("SSH port must be a number from 1 to 65535".into()))?;
    validate_ssh_port(port)
}

fn validate_ssh_port(port: u16) -> Result<u16, Error> {
    if port == 0 {
        Err(Error::Message(
            "SSH port must be a number from 1 to 65535".into(),
        ))
    } else {
        Ok(port)
    }
}

fn print_pairing_screen(
    selected: &AdvertisedEndpoint,
    payload: &PairingPayload,
    expires_at: u64,
    code: &str,
    print_code: bool,
) -> Result<(), Error> {
    let qr = QrCode::with_error_correction_level(code.as_bytes(), EcLevel::L)
        .map_err(|error| Error::Message(format!("could not encode pairing QR: {error}")))?;
    let rendered = qr
        .render::<unicode::Dense1x2>()
        .dark_color(unicode::Dense1x2::Dark)
        .light_color(unicode::Dense1x2::Light)
        .quiet_zone(true)
        .build();
    println!("\nWhipair\n");
    println!(
        "Endpoint: {} ({}, {})",
        selected.label, selected.source, selected.host
    );
    println!(
        "SSH:     {}@{}:{}",
        payload.ssh_user, payload.ssh_host, payload.ssh_port
    );
    println!(
        "Expires: {} seconds\n",
        expires_at.saturating_sub(unix_seconds()?)
    );
    println!("{rendered}");
    println!("Scan with Whip. Press Ctrl-C to cancel.");
    if print_code {
        println!("\n{code}");
    }
    io::stdout().flush()?;
    Ok(())
}

fn confirm_enrollment(deadline: std::time::Instant) -> Result<Option<bool>, io::Error> {
    if std::time::Instant::now() >= deadline {
        return Ok(None);
    }
    print!("Approve? [y/N] ");
    io::stdout().flush()?;
    let mut descriptor = libc::pollfd {
        fd: libc::STDIN_FILENO,
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            println!("\nPairing code expired.");
            return Ok(None);
        }
        let timeout_ms = i32::try_from(remaining.as_millis()).unwrap_or(i32::MAX);
        // SAFETY: descriptor is an initialized pollfd, the pointer is valid for
        // one element, and poll only mutates that element during this call.
        let ready = unsafe { libc::poll(&raw mut descriptor, 1, timeout_ms) };
        if ready > 0 && descriptor.revents & libc::POLLIN != 0 {
            break;
        }
        if ready > 0 {
            return Ok(Some(false));
        }
        if ready == 0 {
            println!("\nPairing code expired.");
            return Ok(None);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(Some(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    )))
}

fn discover_ssh_fingerprint(host: &str, port: u16) -> Result<String, Error> {
    let output = Command::new("ssh-keyscan")
        .args([
            "-T",
            "3",
            "-t",
            "ed25519,ecdsa,rsa",
            "-p",
            &port.to_string(),
            host,
        ])
        .output()
        .map_err(|error| Error::Message(format!("could not run ssh-keyscan: {error}")))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(Error::Message(format!(
            "could not discover the SSH host key for {host}:{port}; ensure sshd is running or pass --ssh-fingerprint"
        )));
    }
    fingerprint_from_ssh_keyscan(&output.stdout).ok_or_else(|| {
        Error::Message(format!(
            "{host}:{port} did not present an SSH host key supported by Whip"
        ))
    })
}

fn fingerprint_from_ssh_keyscan(output: &[u8]) -> Option<String> {
    let mut selected = None;
    for line in String::from_utf8_lossy(output).lines() {
        let mut fields = line.split_whitespace();
        let _host = fields.next();
        let (Some(kind), Some(blob)) = (fields.next(), fields.next()) else {
            continue;
        };
        let Some(preference) = ssh_host_key_preference(kind) else {
            continue;
        };
        let Ok(public_key) = validate_public_key(&format!("{kind} {blob}")) else {
            continue;
        };
        if selected
            .as_ref()
            .is_none_or(|(current, _)| preference < *current)
        {
            selected = Some((preference, fingerprint_public_key(&public_key)));
        }
    }
    selected.map(|(_, fingerprint)| fingerprint)
}

fn ssh_host_key_preference(kind: &str) -> Option<u8> {
    match kind {
        "ssh-ed25519" => Some(0),
        "ecdsa-sha2-nistp256" => Some(1),
        "ecdsa-sha2-nistp384" => Some(2),
        "ecdsa-sha2-nistp521" => Some(3),
        "ssh-rsa" => Some(4),
        _ => None,
    }
}

fn validate_ssh_fingerprint(value: &str) -> Result<String, Error> {
    decode_ssh_fingerprint(value)?;
    Ok(value.to_owned())
}

fn decode_ssh_fingerprint(value: &str) -> Result<[u8; 32], Error> {
    let encoded = value
        .strip_prefix("SHA256:")
        .ok_or_else(|| Error::Message("SSH fingerprint must start with SHA256:".into()))?;
    let decoded = STANDARD_NO_PAD
        .decode(encoded)
        .map_err(|_| Error::Message("SSH fingerprint is not valid Base64".into()))?;
    decoded
        .try_into()
        .map_err(|_| Error::Message("SSH fingerprint must contain a 32-byte SHA-256 digest".into()))
}

fn current_username() -> String {
    std::env::var("USER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown".into())
}

fn unix_seconds() -> Result<u64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| Error::Message("system clock is before the Unix epoch".into()))
}

fn printable_device_name(value: &str) -> String {
    let filtered: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect();
    if filtered.trim().is_empty() {
        "Unknown device".into()
    } else {
        filtered
    }
}

fn write_secret_file(path: &Path, value: &str) -> Result<(), Error> {
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(value.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED25519_BLOB: &str =
        "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const ECDSA_P256_BLOB: &str = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc=";

    #[test]
    fn ssh_keyscan_selection_matches_russh_preference_order() {
        let scan = format!(
            "host ecdsa-sha2-nistp256 {ECDSA_P256_BLOB}\nhost ssh-ed25519 {ED25519_BLOB}\n"
        );
        let ed25519 = validate_public_key(&format!("ssh-ed25519 {ED25519_BLOB}")).unwrap();
        assert_eq!(
            fingerprint_from_ssh_keyscan(scan.as_bytes()),
            Some(fingerprint_public_key(&ed25519))
        );
    }

    #[test]
    fn ssh_keyscan_selection_accepts_ecdsa_without_ed25519() {
        let scan = format!("host ecdsa-sha2-nistp256 {ECDSA_P256_BLOB}\n");
        let ecdsa = validate_public_key(&format!("ecdsa-sha2-nistp256 {ECDSA_P256_BLOB}")).unwrap();
        assert_eq!(
            fingerprint_from_ssh_keyscan(scan.as_bytes()),
            Some(fingerprint_public_key(&ecdsa))
        );
    }

    #[test]
    fn ssh_host_key_preference_covers_russh_defaults() {
        assert_eq!(ssh_host_key_preference("ssh-ed25519"), Some(0));
        assert_eq!(ssh_host_key_preference("ecdsa-sha2-nistp256"), Some(1));
        assert_eq!(ssh_host_key_preference("ecdsa-sha2-nistp384"), Some(2));
        assert_eq!(ssh_host_key_preference("ecdsa-sha2-nistp521"), Some(3));
        assert_eq!(ssh_host_key_preference("ssh-rsa"), Some(4));
        assert_eq!(ssh_host_key_preference("ssh-dss"), None);
    }

    #[test]
    fn restricted_authorization_forces_only_the_exchange_command() {
        let key = temporary_private_key(&[7; 32]);
        let line = temporary_authorized_key_line(
            &key,
            "'/nix/store/example/bin/whipair' exchange --socket '/tmp/example.sock'",
        )
        .unwrap();
        assert!(line.starts_with("restrict,command=\""));
        assert!(line.contains(" exchange --socket "));
    }

    #[test]
    fn fingerprint_digest_round_trips() {
        let digest = [9; 32];
        let fingerprint = format!("SHA256:{}", STANDARD_NO_PAD.encode(digest));
        assert_eq!(decode_ssh_fingerprint(&fingerprint).unwrap(), digest);
    }

    #[test]
    fn interactive_ssh_port_defaults_to_22() {
        assert_eq!(parse_prompted_ssh_port("").unwrap(), 22);
        assert_eq!(parse_prompted_ssh_port("\n").unwrap(), 22);
    }

    #[test]
    fn interactive_ssh_port_accepts_nonstandard_port() {
        assert_eq!(parse_prompted_ssh_port("2222\n").unwrap(), 2222);
    }

    #[test]
    fn interactive_ssh_port_rejects_invalid_values() {
        assert!(parse_prompted_ssh_port("0").is_err());
        assert!(parse_prompted_ssh_port("not-a-port").is_err());
        assert!(parse_prompted_ssh_port("65536").is_err());
    }

    #[test]
    fn advertised_host_accepts_ip_addresses_and_hostnames() {
        assert_eq!(
            validate_advertised_host(" 203.0.113.10\n").unwrap(),
            "203.0.113.10"
        );
        assert_eq!(
            validate_advertised_host("ssh.example.com").unwrap(),
            "ssh.example.com"
        );
    }

    #[test]
    fn advertised_host_rejects_empty_or_whitespace_values() {
        assert!(validate_advertised_host("").is_err());
        assert!(validate_advertised_host("ssh example.com").is_err());
    }

    #[test]
    fn approval_does_not_prompt_after_its_deadline() {
        assert_eq!(confirm_enrollment(std::time::Instant::now()).unwrap(), None);
    }
}
