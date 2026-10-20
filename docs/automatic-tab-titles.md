# Automatic tab titles

Tabs use a transcript title only when the Herdr label is explicitly known to be
automatic. A manual label always wins. Unknown label origins preserve the Herdr
label, including on older servers that omit `label_is_custom`. Whip learns the
origin from its own tab creation/rename results and from explicit rename events.
It keeps that evidence across ordinary snapshot refreshes, but discards it on
reconnection when Whip could have missed a rename. No label-text heuristics
or automatic `tab.rename` requests are used.

Herd tab cards also show the loaded conversation title in a smaller, single-line
subtitle at the bottom. This subtitle is independent of rename status, so the
original tab name stays visible on older servers and manually named tabs.

Title sources are extracted in Rust and delivered through `AgentTranscriptInfo`:

| Agent | Title source |
| --- | --- |
| Claude Code | Latest `customTitle`, falling back to latest `aiTitle` |
| OpenCode v1/v2 | Session `title`, including live session metadata changes |
| Codex | Latest matching `thread_name` in `session_index.jsonl`, falling back to the first meaningful loaded user prompt |

Titles collapse whitespace and are limited to 72 Unicode characters plus an
ellipsis. The tab UI also truncates them to fit its existing single-line layout.

Codex's current `SessionMeta` has no title. Native names are maintained in its
session index and SQLite state. Whip reads only the index beside the loaded
rollout's `sessions` directory, within the existing file metadata SSH request.
An unchanged index is not rescanned. No additional SSH round trips, transcript
loads, polling loops, or LLM requests are introduced. Updates follow the existing
transcript monitor cadence (including its slower idle interval); this is not a
separate push subscription. SQLite-only names are not queried. Missing metadata
falls back to the loaded prompt; malformed or incomplete index records are
retried at the existing cadence without disrupting transcript loading.

Reference inspected: `openai/codex` commit
`014489466a`, especially `codex-rs/protocol/src/protocol.rs`,
`codex-rs/rollout/src/session_index.rs`, and
`codex-rs/thread-store/src/local/update_thread_metadata.rs`.

The presentation cache contains only in-memory titles observed through existing
transcript bindings or an explicitly opened saved transcript. Its keys include
host, pane, terminal, agent, and session identity; tab labels select only panes
belonging to that tab and workspace. Unloading a
transcript retains its title; closing its pane or changing the conversation
invalidates it. A tab with several panes uses its selected terminal's title, or
its focused/first pane when the tab is inactive. It never borrows a title from a
different pane simply because that pane has loaded history. Unknown or empty
titles fall back to the existing Herdr label.
