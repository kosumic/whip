# Antigravity CLI Chat View

Whip opens the conversation UUID or absolute transcript path reported by Herdr’s
Antigravity CLI hook. It reads both `transcript.jsonl` and
`transcript_full.jsonl` in that conversation’s `.system_generated/logs`
directory. Steps are ordered by index. The full log takes precedence where the
two contain the same index. Each file has its own partial-line buffer.

The SSH reader checks a SHA-256 digest of each observed file prefix. An ordinary
append transfers only the new bytes. If the old prefix changed, the reader
reloads that file. It publishes a revision after verifying both inputs. This
handles a late sibling, truncation and equal-length edits. Hashing reads the two
logs on the host each poll. Reconnecting revalidates the source while the
previously saved chat stays available.

Chat View shows prompts, replies, reasoning, usage, compaction summaries, tool
calls, and recorded results. Results occupy the step slots following their
planner response. A missing slot stays open at the live edge. After the next
message, or once Herdr reports the session done and writes have gone quiet,
it shows a notice with the original arguments. A late result replaces that
notice. Background task reports match their original task ID across turns.

Successful edits expose file changes. A recorded diff takes precedence over the
replacement excerpts in the arguments. A write can supply the new file content
without supplying the previous version. Chat View also shows the content of
recorded implementation plan writes, multiple-choice questions, and successful
image reads with a usable path. Interactive approval and artifact review stay
in the terminal. Chat View can only restore turn boundaries, past revisions and
attachments that survive in the logs.

## Replay the public CLI captures

The integration test covers five published Antigravity CLI 1.4.12 captures,
including a denied write, a successful overwrite, a replacement and a command
whose result was absent at capture time. It exercises chunked reads and
restores the resulting chat from its offline checkpoint.
[Capture provenance](https://github.com/judell/bram/tree/a06fbf4eed1e6527559be014989c78fab601f617/docs/agent-specimens/antigravity)

```sh
export WHIP_AGY_CAPTURES="$PWD/.codex/agy-transcript-tests"
mkdir -p "$WHIP_AGY_CAPTURES"
base=https://raw.githubusercontent.com/judell/bram/a06fbf4eed1e6527559be014989c78fab601f617/docs/agent-specimens/antigravity
for name in transcript-record transcript-full-record transcript-record-denied transcript-record-lifecycle transcript-record-tools; do
  curl -fsSL "$base/$name.jsonl" -o "$WHIP_AGY_CAPTURES/$name.jsonl" || exit 1
done
nix develop -c cargo test --locked --manifest-path crates/agent-transcript-core/Cargo.toml --test agy -- --include-ignored
```
