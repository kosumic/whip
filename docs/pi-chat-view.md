# Pi Chat View

Pi panes use Herdr's `agent_session` identity and the native Rust transcript
model. The existing composer sends input to the same terminal.

Whip accepts an exact Pi session ID or an authoritative absolute `.jsonl` path
from Herdr. Paths support custom SDK locations and `--session-dir`. IDs resolve
against `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions`, selecting the newest
exact `_<session-id>.jsonl` filename. Session headers must match ID identities.
Unsafe references and control characters are rejected; paths are shell quoted.

The adapter reads Pi v2/v3 session entries. User text and images, assistant text
and visible thinking, tool calls and results, model/provider/token usage,
interruptions, errors, and session names become neutral transcript values.
Tool results update their matching calls rather than creating user bubbles.
Recorded unified edit patches appear in tool details. Signatures, redacted
thinking, system prompts, and extension state are omitted.

Projection follows the last persisted entry through `parentId`, preserving
metadata links and excluding abandoned sibling branches. Compaction and branch
summary entries link history without becoming user prompts. Original messages
on the active branch remain available. Context edits do not rewrite raw history.
An in-memory tree selection without a new persisted entry cannot be observed.
Custom extension rendering and direct `bashExecution` messages are currently
omitted. Updates appear when Pi persists records; token-by-token SDK events are
not stored in the session file.

Pi and Claude share the JSONL session lifecycle: bounded byte framing, source
identity, incremental deltas, partial-line handling, checkpoint confirmation,
reconnect offsets, source replacement, and normalized caches. Saved Pi chats,
search, and speech use the same native model as live Chat. Existing Claude v2/v3
checkpoints remain readable.

The authored fixture follows Pi's
[session format](https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/coding-agent/docs/session-format.md)
and [message types](https://github.com/earendil-works/pi/blob/6c384aa30f619d7b28963f2bab24d8dacbe73cb6/packages/coding-agent/docs/message-types.md).
No Pi code or dependencies are bundled.

An explicit integration test also downloads two real public Pi v3 captures:

- [cmgriffing's error reproduction](https://gist.github.com/cmgriffing/84bb13df3d3cfed747d2bdb379341a3c):
  19 records, 38,816 bytes, 8 tool calls, including a failed tool and a provider
  error. Pinned file revision `920d8be65eda40e3d4cb45980495c0f53d5fcf41`, SHA-256
  `39d230f343722c26d038511a7da3b34aa25b21705751edcb57d898c342cba749`.
- [tunnckoCore's coding session](https://gist.github.com/tunnckoCore/a40bcdcdf9bb8ef0bdd04ad01c4d2652):
  117 records, 1,119,828 bytes, 7 user turns, 55 tool calls. Pinned file revision
  `ebddd937ff428046de0c00f56f2a112bba2e3fc5`, SHA-256
  `06ac331f80792cd876410efb4bbe683394d5962cd1300169dc50960b034c6bd8`.

Run `nix develop -c node scripts/test-pi-transcript.ts`. The downloader verifies
the exact bytes and keeps conversation bodies under ignored
`.codex/pi-transcript-tests/`. Normal tests remain offline. The integration test
checks message/turn counts, reasoning, model and token metadata, tool-result
matching and errors, chunked reads, and cache recovery at every physical record
boundary with a partial next record in flight.

Validation:

```sh
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib
nix develop -c node_modules/.bin/jest --runInBand --runTestsByPath __tests__/agentChatSession.test.ts __tests__/agentChatOpen.test.tsx __tests__/sessionChatOpen.test.tsx __tests__/agentIntegrationInstall.test.ts __tests__/chatSpeech.test.ts
nix develop -c node_modules/.bin/tsc --noEmit
```
