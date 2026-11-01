//! Opt-in interoperability with the official, checksum-verified core binary.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "isolated fixture setup and protocol assertions fail the test immediately on unexpected results"
)]
use super::*;
use crate::ssh::ReverseForwardFixture as Fixture;
use herdr_protocol::hc::{generated as api, terminal::Geometry};
use std::{collections::BTreeMap, path::PathBuf, process::Command};

struct Server {
    binary: PathBuf,
    root: PathBuf,
    environment: BTreeMap<String, String>,
}

#[derive(Default)]
struct Renderer {
    frames: std::sync::atomic::AtomicUsize,
    ready: Notify,
}
impl crate::herdr_terminal::HerdrTerminalEventSink for Renderer {
    fn terminal_frame(
        &self,
        _client_key: String,
        _terminal_id: String,
        _sequence: u64,
        _width: u16,
        _height: u16,
        _full: bool,
        _base64_bytes: String,
    ) {
        self.frames
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.ready.notify_one();
    }
    fn graphics_frame(&self, _client_key: String, _terminal_id: String, _bytes: Vec<u8>) {}
    fn control(
        &self,
        _client_key: String,
        _terminal_id: String,
        _event: crate::herdr_terminal::HerdrTerminalControlEvent,
    ) {
    }
}
struct RendererGuard;
impl Drop for RendererGuard {
    fn drop(&mut self) {
        crate::herdr_terminal::clear_herdr_terminal_event_sink();
    }
}
impl Server {
    fn start() -> Self {
        let binary = std::fs::canonicalize(
            std::env::var("WHIP_HC_TEST_BINARY")
                .expect("set WHIP_HC_TEST_BINARY to the pinned core binary"),
        )
        .unwrap();
        let root = std::env::temp_dir().join(format!("whip-hc-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).unwrap();
        let mut environment = BTreeMap::new();
        for (key, value) in [
            ("HOME", root.clone()),
            ("XDG_STATE_HOME", root.join("state")),
            ("XDG_CONFIG_HOME", root.join("config")),
            ("XDG_RUNTIME_DIR", root.join("run")),
            ("HC_SOCKET", root.join("core.sock")),
        ] {
            environment.insert(key.into(), value.to_str().unwrap().into());
        }
        environment.insert("HC_SESSION".into(), "test".into());
        std::fs::create_dir_all(root.join("run")).unwrap();
        let server = Self {
            binary,
            root,
            environment,
        };
        let output = server
            .command()
            .args(["server", "start", "--json"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        server
    }
    fn command(&self) -> Command {
        let mut command = Command::new(&self.binary);
        command.envs(&self.environment);
        command
    }
    fn connection(&self, ssh: Arc<crate::ssh::SshSession>) -> Arc<HerdrConnection> {
        let connection = HerdrConnection::new(
            uuid::Uuid::new_v4().to_string(),
            "test".into(),
            Some(self.environment["HC_SOCKET"].clone()),
            None,
            true,
        );
        connection.configure_backend(
            crate::HostHerdrBackend::Core,
            self.binary.to_str().unwrap().into(),
        );
        connection.install(1, ssh);
        connection
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.command().args(["server", "stop", "--json"]).output();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
#[ignore = "requires WHIP_HC_TEST_BINARY; starts an isolated core and loopback SSH server"]
#[allow(
    clippy::too_many_lines,
    reason = "one isolated end-to-end scenario preserves the same core, SSH transport and program across detach and restart"
)]
fn real_core_socket_multiplex_documents_reconnect_and_exec_fallback() {
    let server = Server::start();
    crate::runtime().unwrap().block_on(async {
        let ssh = Fixture::with_commands(true, Duration::ZERO, Some(server.environment.clone()))
            .await
            .unwrap();
        let connection = server.connection(ssh.ssh.clone());
        let core = connection.core().await.unwrap();
        assert!(matches!(*core.stream.lock(), Some(ByteStream::Socket(_))));
        let created = core
            .control(
                HerdrControlRequest::WorkspaceCreate {
                    label: Some("Shared space".into()),
                    cwd: Some(server.root.to_str().unwrap().into()),
                },
                "real-create",
            )
            .await
            .unwrap();
        let HerdrControlResult::WorkspaceCreated {
            workspace,
            tab,
            root_pane,
        } = created
        else {
            panic!("wrong create result");
        };
        assert_eq!(workspace.label, "Shared space");
        assert_eq!(root_pane.agent_status, crate::HerdrAgentStatus::Unknown);
        let renderer = Arc::new(Renderer::default());
        crate::herdr_terminal::set_herdr_terminal_event_sink(renderer.clone());
        let _renderer_guard = RendererGuard;
        crate::herdr_terminal::start_bridge_on_runtime(
            connection.clone(),
            hc::GENERATION,
            root_pane.terminal_id.clone(),
            false,
            80,
            24,
            8,
            16,
            crate::HerdrTerminalAttachLaunchMode::LegacyTerminalAttach,
            |_| Ok(()),
        )
        .await
        .unwrap();
        tokio::time::timeout(TIMEOUT, renderer.ready.notified())
            .await
            .unwrap();
        assert!(renderer.frames.load(std::sync::atomic::Ordering::Relaxed) > 0);
        crate::herdr_terminal::herdr_terminal_resize(
            connection.client_key().into(),
            root_pane.terminal_id.clone(),
            90,
            30,
            8,
            16,
        )
        .unwrap();
        let Response::TerminalGet(resized) = core
            .rpc(Request::terminal_get(api::TerminalGetParams {
                terminal: root_pane.terminal_id.clone(),
                ..Default::default()
            }))
            .await
            .unwrap()
        else {
            panic!("wrong resized terminal");
        };
        assert_eq!((resized.cols, resized.rows), (90, 30));
        crate::herdr_terminal::close_herdr_terminal_bridge(
            connection.client_key().into(),
            root_pane.terminal_id.clone(),
        );
        let mut channels = Vec::new();
        for _ in 0..2 {
            let Response::TerminalAttach(reply) = core
                .rpc(
                    Geometry::new(80, 24, [8, 16])
                        .unwrap()
                        .attach(root_pane.terminal_id.clone(), false),
                )
                .await
                .unwrap()
            else {
                panic!("wrong attach result");
            };
            channels.push(reply.channel);
        }
        // Concurrent channel-zero operations continue with two attached viewers.
        let (list, doc) = tokio::join!(
            core.rpc(Request::terminal_list(api::TerminalListParams::default())),
            core.rpc(Request::doc_get(api::DocGetParams {
                name: "herdr-app".into(),
                on: None
            }))
        );
        assert!(matches!(list.unwrap(), Response::TerminalList(_)));
        let Response::DocGet(document) = doc.unwrap() else {
            panic!("wrong document result");
        };
        let mut changed = document.value.clone();
        changed["future"] = serde_json::json!({"opaque":[1,2,3]});
        core.rpc(Request::doc_set(api::DocSetParams {
            name: "herdr-app".into(),
            on: None,
            version: document.version,
            value: changed,
        }))
        .await
        .unwrap();
        // A stale compare-and-swap fails rather than discarding the other writer.
        assert!(matches!(
            core.rpc(Request::doc_set(api::DocSetParams {
                name: "herdr-app".into(),
                on: None,
                version: document.version,
                value: document.value.clone()
            }))
            .await,
            Err(CallError::Protocol(hc::Error::Rpc(_)))
        ));
        core.control(
            HerdrControlRequest::TabRename {
                tab_id: tab.tab_id,
                label: "Renamed".into(),
            },
            "rename",
        )
        .await
        .unwrap();
        let Response::DocGet(document) = core
            .rpc(Request::doc_get(api::DocGetParams {
                name: "herdr-app".into(),
                on: None,
            }))
            .await
            .unwrap()
        else {
            panic!("wrong document result");
        };
        assert_eq!(
            document.value["future"],
            serde_json::json!({"opaque":[1,2,3]})
        );
        for channel in &channels {
            let items = tokio::time::timeout(TIMEOUT, core.read_channel(*channel))
                .await
                .unwrap()
                .unwrap();
            assert!(items.iter().any(|i| matches!(i, StreamItem::Data(_))));
            for item in items {
                if let StreamItem::Data(bytes) = item {
                    core.consumed(*channel, bytes.len()).unwrap();
                }
            }
            core.stream_close(*channel).unwrap();
        }
        // Detaching viewers leaves the program alive.
        let Response::TerminalGet(terminal) = core
            .rpc(Request::terminal_get(api::TerminalGetParams {
                terminal: root_pane.terminal_id.clone(),
                ..Default::default()
            }))
            .await
            .unwrap()
        else {
            panic!("wrong terminal result");
        };
        assert_eq!(terminal.state, "live");
        // Restart core while SSH and the held program remain alive. A new
        // subscription starts from a fresh snapshot, even if sequence resets.
        core.rpc(Request::server_restart(api::ServerRestartParams::default()))
            .await
            .unwrap();
        tokio::time::timeout(TIMEOUT, async {
            while core.is_alive() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let restarted = connection.core().await.unwrap();
        assert!(!Arc::ptr_eq(&core, &restarted));
        let Response::TerminalGet(terminal) = restarted
            .rpc(Request::terminal_get(api::TerminalGetParams {
                terminal: root_pane.terminal_id.clone(),
                ..Default::default()
            }))
            .await
            .unwrap()
        else {
            panic!("wrong restarted terminal");
        };
        assert_eq!(terminal.state, "live");
        connection.clear(1);
        assert!(!core.is_alive());
        connection.install(2, ssh.ssh.clone());
        let reconnected = connection.core().await.unwrap();
        assert!(!Arc::ptr_eq(&core, &reconnected));
        let HerdrControlResult::SessionSnapshot { snapshot } = reconnected
            .control(HerdrControlRequest::SessionSnapshot, "snapshot")
            .await
            .unwrap()
        else {
            panic!("wrong snapshot");
        };
        crate::host_state::validate_snapshot(&snapshot).unwrap();
        assert!(
            snapshot
                .panes
                .iter()
                .any(|p| p.terminal_id == root_pane.terminal_id)
        );
        connection.clear(2);
        // A host that rejects direct-streamlocal still uses the identical codec.
        ssh.deny_streamlocal();
        connection.install(3, ssh.ssh.clone());
        let fallback = connection.core().await.unwrap();
        assert!(matches!(*fallback.stream.lock(), Some(ByteStream::Exec(_))));
        assert!(matches!(
            fallback
                .control(HerdrControlRequest::SessionSnapshot, "exec-snapshot")
                .await
                .unwrap(),
            HerdrControlResult::SessionSnapshot { .. }
        ));
        connection.clear(3);
    });
}
