//! Process ownership and the installed Tailcat CLI's stdin/stdout transport.
use std::{
    ffi::OsString,
    io,
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{sleep, timeout},
};

use crate::{DEFAULT_SSH_PORT, Error, ServeArgs, validate_ssh_port, validate_tailcat_address};

const KEY_OPTION: &str = "--key";
const BUILTIN_SERVICE: &str = "no-auth-ssh";
const START_TIMEOUT: Duration = Duration::from_secs(120);
const ADDRESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
const INSTALL_MESSAGE: &str = "Tailcat is required. Install it first: https://github.com/tailscale/tailcat/blob/main/INSTALL.md";

fn command() -> Command {
    let mut command = Command::new("tailcat");
    command.kill_on_drop(true);
    command
}

fn spawn_error(error: io::Error) -> Error {
    if error.kind() == io::ErrorKind::NotFound {
        Error::Message(INSTALL_MESSAGE.into())
    } else {
        Error::Io(error)
    }
}

/// The child remains owned by the SSH stream and is killed when it is dropped.
pub(crate) struct Stream {
    _child: Child,
    input: ChildStdin,
    output: ChildStdout,
}

impl Stream {
    pub(crate) fn connect(address: &str, port: u16) -> Result<Self, Error> {
        let mut child = command()
            .arg("--key=new")
            .arg(address)
            .arg(port.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(spawn_error)?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("missing Tailcat stdin"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("missing Tailcat stdout"))?;
        Ok(Self {
            _child: child,
            input,
            output,
        })
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.output).poll_read(context, buffer)
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.input).poll_write(context, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.input).poll_flush(context)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.input).poll_shutdown(context)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Service {
    Builtin,
    Host(u16),
}

fn service(args: &ServeArgs) -> Result<(Service, bool), Error> {
    let mut builtin = false;
    let mut ports = Vec::new();
    let mut specified = false;
    let mut skip_value = false;
    for value in &args.tailcat_args {
        let value = value.to_string_lossy();
        if skip_value {
            skip_value = false;
            continue;
        }
        // These Tailcat options accept separate values that could resemble a service.
        if [
            KEY_OPTION,
            "--allow",
            "--ssh-authorized-keys",
            "--files",
            "--region",
            "--derp-map",
        ]
        .contains(&value.as_ref())
        {
            skip_value = true;
            continue;
        }
        if value.starts_with('-') {
            continue;
        }
        for part in value.split(',') {
            if part == BUILTIN_SERVICE {
                builtin = true;
                specified = true;
            } else if let Ok(port) = part.split('=').next().unwrap_or(part).parse::<u16>() {
                ports.push(validate_ssh_port(port)?);
                specified = true;
            } else if part == "files" {
                specified = true;
            } else if ["ssh", "exec", "exit-node"].contains(&part) {
                return Err(Error::Message(
                    "pairing requires no-auth-ssh or forwarded SSH ports after --".into(),
                ));
            }
        }
    }
    if specified && !builtin && ports.is_empty() {
        return Err(Error::Message(
            "include no-auth-ssh or an SSH port among Tailcat's services".into(),
        ));
    }
    if !args.host_ssh && (builtin || !specified) {
        if args.ssh_port.is_some_and(|port| port != DEFAULT_SSH_PORT) {
            return Err(Error::Message("the built-in SSH service uses port 22; pass a forwarded port after -- for host SSH".into()));
        }
        return Ok((Service::Builtin, specified));
    }
    let port = match (args.ssh_port, ports.as_slice()) {
        (Some(port), []) => validate_ssh_port(port)?,
        (Some(port), ports) if ports.contains(&port) => port,
        (Some(_), _) => {
            return Err(Error::Message(
                "-p must select one of Tailcat's forwarded ports".into(),
            ));
        }
        (None, [port]) => *port,
        (None, []) => DEFAULT_SSH_PORT,
        (None, _) => {
            return Err(Error::Message(
                "Tailcat serves multiple ports; use -p to select the SSH port".into(),
            ));
        }
    };
    Ok((Service::Host(port), specified))
}

struct Server {
    child: Child,
    address: String,
}

impl Server {
    async fn start(args: &[OsString], service: &Service, specified: bool) -> Result<Self, Error> {
        Self::start_command(command(), args, service, specified).await
    }

    async fn start_command(
        mut cmd: Command,
        args: &[OsString],
        service: &Service,
        specified: bool,
    ) -> Result<Self, Error> {
        let directory = tempfile::Builder::new()
            .prefix("whipair-tailcat-")
            .tempdir()?;
        let address_path = directory.path().join("address");
        cmd.arg("serve");
        cmd.args(args);
        if !specified {
            cmd.arg(match service {
                Service::Builtin => BUILTIN_SERVICE.into(),
                Service::Host(port) => port.to_string(),
            });
        }
        let mut child = cmd
            .kill_on_drop(true)
            .env("TAILCAT_ADDR_FILE", &address_path)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .process_group(0)
            .spawn()
            .map_err(spawn_error)?;
        let address = loop {
            if let Some(status) = child.try_wait()? {
                return Err(Error::TailcatExit(status));
            }
            match std::fs::read_to_string(&address_path) {
                Ok(value) if !value.trim().is_empty() => break value.trim().to_owned(),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            sleep(ADDRESS_POLL_INTERVAL).await;
        };
        validate_tailcat_address(&address)?;
        Ok(Self { child, address })
    }

    async fn stop(&mut self) -> Result<(), Error> {
        if self.child.try_wait()?.is_none() {
            self.child.kill().await?;
        }
        Ok(())
    }
}

pub(crate) async fn serve_wrapped(mut args: ServeArgs) -> Result<(), Error> {
    let (service, specified) = service(&args)?;
    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);
    let mut server = tokio::select! {
        started = timeout(START_TIMEOUT, Server::start(&args.tailcat_args, &service, specified)) =>
            started.map_err(|_| Error::Message("Tailcat server startup timed out".into()))??,
        result = &mut shutdown => { result?; return Ok(()); },
    };
    args.tailcat_address = Some(server.address.clone());
    args.host_ssh = matches!(service, Service::Host(_));
    args.ssh_port = Some(match service {
        Service::Builtin => DEFAULT_SSH_PORT,
        Service::Host(port) => port,
    });
    let outcome = async {
        let paired = tokio::select! {
            result = crate::serve(args) => { result?; true },
            status = server.child.wait() => return Err(Error::TailcatExit(status?)),
            result = &mut shutdown => { result?; false },
        };
        if paired {
            tokio::select! {
                status = server.child.wait() => return Err(Error::TailcatExit(status?)),
                result = &mut shutdown => result?,
            }
        }
        Ok(())
    }
    .await;
    server.stop().await?;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[tokio::test]
    async fn wrapper_preserves_arguments_and_stops_the_owned_server() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("tailcat.sh");
        let recorded = directory.path().join("args");
        std::fs::write(&script, r#"printf '%s\n' "$@" > "$WHIP_TEST_ARGS"
printf '%s' 'tco2FwWCABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAWFrWCACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAmFpAQ' > "$TAILCAT_ADDR_FILE"
printf 'tailcat fixture stdout\n'
printf 'tailcat fixture stderr\n' >&2
exec sleep 30
"#).unwrap();
        let mut cmd = Command::new("sh");
        cmd.arg(script).env("WHIP_TEST_ARGS", &recorded);
        let args = ["--key", "server key with spaces", BUILTIN_SERVICE].map(OsString::from);
        let mut server = Server::start_command(cmd, &args, &Service::Builtin, true)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(recorded).unwrap(),
            "serve\n--key\nserver key with spaces\nno-auth-ssh\n"
        );
        assert!(server.child.try_wait().unwrap().is_none());
        server.stop().await.unwrap();
        assert!(server.child.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn wrapper_preserves_tailcat_exit_status_before_readiness() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "exit 7"]);
        let result = Server::start_command(cmd, &[], &Service::Builtin, false).await;
        assert!(matches!(result, Err(Error::TailcatExit(status)) if status.code() == Some(7)));
    }

    #[test]
    fn wrapper_preserves_tailcat_arguments_and_infers_a_single_forwarded_port() {
        let cli =
            crate::Cli::try_parse_from(["whipair", "--tailcat", "--", "--key=custom", "2222"])
                .unwrap();
        assert_eq!(
            cli.serve.tailcat_args,
            vec![OsString::from("--key=custom"), OsString::from("2222")]
        );
        assert_eq!(service(&cli.serve).unwrap(), (Service::Host(2222), true));
    }

    #[test]
    fn wrapper_defaults_to_builtin_and_accepts_host_override() {
        let cli = crate::Cli::try_parse_from(["whipair", "--tailcat"]).unwrap();
        assert_eq!(service(&cli.serve).unwrap(), (Service::Builtin, false));
        let cli = crate::Cli::try_parse_from(["whipair", "--tailcat", "--host-ssh", "-p", "2222"])
            .unwrap();
        assert_eq!(service(&cli.serve).unwrap(), (Service::Host(2222), false));
    }

    #[test]
    fn wrapper_requires_an_ssh_port_when_multiple_ports_are_forwarded() {
        let cli = crate::Cli::try_parse_from(["whipair", "--tailcat", "--", "2222,8080"]).unwrap();
        assert!(service(&cli.serve).is_err());
        let cli =
            crate::Cli::try_parse_from(["whipair", "--tailcat", "-p", "2222", "--", "2222,8080"])
                .unwrap();
        assert_eq!(service(&cli.serve).unwrap(), (Service::Host(2222), true));
    }

    #[test]
    fn wrapper_accepts_file_service_and_port_mappings_without_rewriting_them() {
        let cli = crate::Cli::try_parse_from([
            "whipair",
            "--tailcat",
            "--",
            "--files=/tmp",
            "no-auth-ssh,files",
        ])
        .unwrap();
        assert_eq!(service(&cli.serve).unwrap(), (Service::Builtin, true));
        let cli = crate::Cli::try_parse_from(["whipair", "--tailcat", "--", "2222=127.0.0.1:22"])
            .unwrap();
        assert_eq!(service(&cli.serve).unwrap(), (Service::Host(2222), true));
    }
}
