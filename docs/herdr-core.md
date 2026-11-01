# Herdr Core hosts

New hosts default to **Legacy Herdr**. Choose **Herdr Core** in a host's backend
selector for herdr-core/hc and the new desktop app. Saved backend choices are
preserved. **Automatic** is also available: it prefers installed hc, then
installed legacy Herdr; when neither is installed it offers core setup.
Disabling Herdr keeps plain SSH available.

Whip reuses its authenticated SSH connection, including ProxyJump and Tailcat.
On Unix it discovers and forwards the core socket. Saved socket/session overrides
take precedence; discovery reads `HC_SOCKET`, XDG paths and `core.lock`, which
also preserves the core's configured socket override. If direct-streamlocal is
unavailable, `hc connect` supplies the same protocol through SSH exec. Supported
Windows shells can use this fallback with an installed hc.

The protocol implementation lives in the independently publishable
`crates/herdr-protocol` library. Whip owns SSH, deadlines, task scheduling,
cancellation, renderer delivery and connection generations. The library owns
hello/framing, RPC correlation, channel limits/credit, event reduction, document
conflicts, layout edits and backend-neutral state. Legacy protocol generations
17–22 remain supported through their existing codec and API.

The desktop's `herdr-app` document supplies shared spaces, tabs and terminal
blocks. Writes include the expected document version, retain unknown fields and
mods, and retry only explicit version conflicts after refetching. Focus and zoom
stay private. Without a desktop document, live terminals appear in a terminal
fallback workspace and can be adopted into a shared layout when edited.

Core terminal output is ANSI with local renderer scrollback. Each attachment has
an independent bounded consumer; credit follows delivery. Closing a viewer
detaches it. Explicit close actions stop the selected programs. Lost transport
does not imply program exit; a fresh subscription and snapshot restore state.
Partially completed creates/writes report the acknowledged terminals and do not
silently repeat side effects.

Core terminal metadata preserves parent relationships, and OSC 7501 reports define agent status. Whip does not infer
activity or completion from screen text. Transcript chat is available only with
reliable provider session identity, currently explicit `whip.transcript.agent`,
`whip.transcript.kind` (`id` or `path`) and `whip.transcript.value` labels. A core
terminal address is never used as a provider session ID.

Core setup displays the official `https://releases.herdr.dev/core/install.sh`
command for confirmation. Legacy agent integration installers are unavailable
on core; core agent launches use `terminal.run` and the host's core templates.

For native interoperability tests, obtain the pinned binary with
`bash scripts/fetch-herdr-core-test.sh DESTINATION`, set `WHIP_HC_TEST_BINARY` to
the printed path, then run the ignored `hc_transport::tests` test through
`cargo test --lib hc_transport::tests -- --ignored --test-threads=1` from the
native Rust crate. Tests create isolated HOME/XDG/session/socket state and a real
loopback SSH server. They never use the user's running core.
