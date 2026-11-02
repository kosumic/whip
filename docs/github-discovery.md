# GitHub discovery

The terminal's GitHub button opens the discovered repository's HTTPS URL through
the operating system. GitHub Mobile handles it when installed and enabled for
GitHub links; otherwise the URL opens in the default browser. Whip does not host
an in-app GitHub viewer. GitHub sign-in happens in the destination app or browser.

Whip probes the active pane's foreground CWD, pane CWD, and workspace checkout,
in that order, skipping duplicates. A foreground GitHub repository wins; a
confirmed negative or inaccessible directory permits fallback. An SSH/probe
failure stops the search so an unknown foreground repository cannot be replaced
by an unrelated workspace repository. Each search probes at most three paths.

Discovery is local to the SSH host and requires no GitHub login or network
request. `gh` must be available in the host's **login shell PATH**. A missing
CLI, inaccessible directory, SSH command-channel failure, and confirmed
non-GitHub directory have separate outcomes. The GitHub control shows pending
or unresolved status; tap it for details and Retry discovery. Confirmed
non-GitHub locations hide the control. Keyboard-open hiding is unchanged.

For standalone SSH shells, Whip consumes OSC 7 `file://hostname/absolute/path`
reports from that shell's output. Parsing is bounded to 4 KiB per sequence,
supports BEL and ST terminators and chunk boundaries, and decodes URL-escaped
paths. Reports must contain absolute paths without control characters. CWD
metadata is cleared when the shell reopens or the host reconnects. The getter
and change notifications work independently of the terminal rendering bridge.
Shells without OSC 7 reporting show an unknown-directory status; Whip does not
probe the login directory or reuse a workspace's repository for them.

Query identity includes the native runtime instance, connection generation,
terminal, and ordered paths. Abandoned queries stop before probing another
candidate. Discovery refreshes every 30 seconds and when the app returns to the
foreground; retry does not reset the terminal. Native read deadlines and bounded
SSH retries also apply to discovery.

Diagnostics record ordered candidate path fingerprints, probe outcomes, safe
error codes and connection generation. Repeated identical outcomes are
suppressed in a bounded cache. Directory text, command bodies, command output,
credentials and arbitrary error messages are excluded. The hook retains the
original structured native error separately for inspection.
