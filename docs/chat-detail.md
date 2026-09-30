# Shared chat detail

The Compact / Detailed control at the top right of chat applies to OpenCode,
Codex, and Claude Code, including saved chats. The selection is a device
preference; Compact is the default.

- Compact groups consecutive reasoning and tool activity behind an expandable
  summary. Running activity has a progress indicator; failed tools remain visible.
- Detailed shows reasoning inline and individual tool rows, retaining the existing
  read/search groups. Tool output and file diffs still expand on demand.
- Answers, normalized plans, notices, and question tools remain visible in both
  modes. Questions still require answering in Terminal; this does not add native
  approval, question-response, queue, or steering APIs.

Rust continues to own transcript parsing, normalization, reconciliation, and
caching. Detail modes only change presentation rows in React Native. Original
part identities and expansion choices survive detail changes and viewport
eviction. A reading anchor stays on the same row where possible; a hidden row
maps to its activity summary. Following the end also handles content shrinking.

Regression tests cover the three agents' tool-name shapes, live reasoning,
completion/failure updates, visible questions, persisted preferences, mode
switches, reading anchors, end following, and viewport eviction.

For native validation, open a long conversation for each agent and check:

1. Scroll upward, switch modes, and verify that the same answer or corresponding
   activity stays in view, without jumping to the latest message.
2. Expand an activity and its tool output, switch modes twice, then leave and
   reopen chat. Both expansion choices should survive.
3. At the end of a live chat, switch modes while content streams or tools finish.
   The newest content should stay visible, including when rows collapse.
4. Open and dismiss the keyboard, scroll inside long shell output, and switch
   sessions. Check for blank frames, overlapping rows, or unexpected jumps.

Component tests use a mocked list and cannot prove native layout continuity.
