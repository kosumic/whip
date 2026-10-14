# Chat transcript details

Codex, OpenCode v1/v2, and Claude Code share an expandable turn footer with
model/provider, token usage, timestamps, and the recorded turn outcome. Tool
cards expose start/finish times, duration, shell exit code (including zero),
and an expandable input viewer. Assistant segments show their recorded time.
Missing metadata stays absent; the provider is not inferred from a model name.

The layout follows OpenCode v2's compact transcript, expandable tool bodies,
and response footer. Its desktop UI includes model labels; its mobile UI
normally keeps those labels in the composer and model-switch notices. Whip
exposes historical model details in the footer because its composer sends
input to an existing remote agent.

Reference inspected: OpenCode commit
`3a69bae8459b1aa9b122456a55d9535b23125f33`, particularly
`packages/session-ui/src/message/message-content.tsx`,
`packages/session-ui/src/components/basic-tool.tsx`, and
`packages/schema/src/token-usage.ts`.

## Accounting and lifecycle

Rust normalizes input/output counts to include their respective subsets:

| Source | Input | Output | Outcome |
| --- | --- | --- | --- |
| Codex | `input_tokens` (includes cached input) | `output_tokens` (includes reasoning) | Turn completion/error/abort |
| OpenCode | Input + cache read + cache write | Output + reasoning | Finish/error; v2 idle outcome |
| Claude Code | Input + cache read + cache creation | Output (already includes thinking) | Stop reason, interruption, API error |

Cache reads/writes and reasoning appear separately in the expanded breakdown;
they are not added to the inclusive total again. Unreported categories are
unknown, including Claude's separate thinking-token count. Claude records that
share an API response ID contribute one usage entry, retaining the largest
reported count in each category. Codex's repeated cumulative token snapshots
contribute only new usage; a reset uses the last reported response usage.
Claude responses with no visible content still retain their usage. Local error
records using the `<synthetic>` model do not replace the last real model or
contribute placeholder usage; the API-error flag overrides their stop reason.

The turn footer shows a green check-circle for a cache hit with the percentage
of input tokens read from cache, a muted cross-circle for a miss, and a muted
question-circle for unknown. A miss requires positive input and an explicitly
zero cache-read count. Missing counts, zero input, and invalid counts remain
unknown; cache writes alone do not establish a hit. The expanded footer names
the status, and the footer's accessibility hint includes it.

OpenCode v2 idle markers carry outcome metadata without becoming chat bubbles.
A later assistant segment reopens that outcome. Failed tools alone do not
override an explicitly successful final response. When no terminal outcome is
recorded, chat retains the existing working/error/interruption presentation
without inventing a successful completion.

Raw tool inputs retain nested JSON and are capped at 64 KiB with an explicit
truncation marker. Existing compact headers continue using normalized fields.
Source durations take precedence over a duration calculated from start/end
timestamps; absent or inverted timestamps do not produce an invented duration.

Codex caches replay their raw records. Older OpenCode and Claude checkpoints
preserve offline history and reread the remote source on reconnection to fill
metadata absent from the old normalized cache format.
