# Pinned chat context

Chat keeps a compact preview of the most recent user prompt above the visible
history at the top of the screen. It follows the history being read, including
follow-up prompts within one turn, and yields while the original prompt is
still visible. Tap the preview to reveal that message without enabling automatic
scrolling. Image-only prompts show an attachment label. Search temporarily takes
over the top of the screen so pinned context cannot cover a search result.

A live chat keeps its current tool, streaming response, or thinking activity
above the bottom controls, including during scrolling. Activity changes do not
move a reader looking through earlier history. Tap the activity strip to return
to the latest output and resume following. The strip disappears when work ends
or the transcript is no longer live. Transcript rows retain their original
content for copying and search.

The interaction follows Codex CLI's `transcript_view/prompt_header.rs`, inspected
from the refreshed local checkout at `8c076942cb70fba8e5c4732c23f1faabc4aed484`.

# Agent input notices

Chat displays read-only notices from transcript records. It does not read the
CLI/TUI screen, infer notices from Herdr's blocked status, or send responses.

Question tool calls from Claude Code (`AskUserQuestion`), Codex
(`request_user_input` and `request_user_input_async`), and OpenCode (`question`)
show **Question requested** with the recorded question text and options when
available. Rust retains structured question data; React Native displays that
projection. Tap an option to copy its exact label to the clipboard, with haptic
and brief checkmark feedback. Copying does not send an answer or approve a
request. Recorded answers and errors remain visible with the question.

Paginated Codex history records asynchronous question calls as `AgentMessage`
items with `delivery: "async"` and a structured `questions` array. Whip projects
those items as question tools using their recorded call IDs, instead of rendering
the duplicate Markdown question. Async question titles and string options are
normalized alongside the synchronous question and option-object formats.

Codex asynchronous question replies can arrive as user messages wrapped in
`send_user_message_question_reply` with a JSON answer array. Whip displays the
answer text in order, without the envelope or internal question IDs. Both legacy
and paginated history apply this during live updates and raw cache replay.
Quoted examples and malformed envelopes remain visible as ordinary user text.

Codex approval and question events become historical notices with the available
question, reason, command, requested permissions, or affected file names. They
do not claim the request is still pending. Notices remain visible in saved or
stale history and asynchronous questions can appear while the agent works.

An agent's transcript must contain the request or question tool call. Approval
prompts omitted from the transcript cannot be shown through this path. A blocked
pane alone does not create a notice. Respond through the agent's terminal.

Validation:

```sh
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib
nix develop -c node_modules/.bin/jest --runInBand --runTestsByPath __tests__/agentChatViewport.test.tsx __tests__/sessionChatOpen.test.tsx
nix develop -c node_modules/.bin/tsc --noEmit
```
