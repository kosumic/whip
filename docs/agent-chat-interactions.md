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
