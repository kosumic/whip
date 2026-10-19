# Chat and terminal selection

Each terminal remembers whether Chat or Terminal was selected, including across
app restarts. Opening Chat in one terminal does not change another terminal's
selection. Offline hosts restore cached Chat when available. Closing a terminal
discards its selection; new terminals start in Terminal.

# Pinned chat context

Chat keeps a compact preview of the most recent user prompt above the visible
history at the top of the screen. It follows the history being read, including
follow-up prompts within one turn, and yields while the original prompt is
still visible. Tap the preview to reveal that message without enabling automatic
scrolling. Image-only prompts show an attachment label. Search temporarily takes
over the top of the screen so pinned context cannot cover a search result.

A live chat shows animated **Working (5s)** inline at the end of the transcript.
At the latest output there is no floating activity bar. Reading earlier history
reveals a compact bar above the controls when a useful summary or tool is
available. Tap it to return to the latest output and resume following. Returning
near the bottom immediately hides the bar. The inline row keeps its layout while
offscreen, so these transitions do not change the scroll range.

The strip shows the latest usable reasoning-summary line as soon as it arrives,
including summaries already marked complete by Codex. Heading and leading bold
formatting are removed, and empty or incomplete updates retain the last useful
line. Recorded assistant progress text supplies context when reasoning summaries
are absent. A concrete in-flight tool takes priority immediately and remains
visible for at least three seconds from its first display. A long call remains
until it finishes. Completion before three seconds retains the call for the
remaining time, then restores the newest reasoning summary. New summaries and
metadata updates do not restart that deadline; a new call gets a fresh window.
Opaque Codex code wrappers never replace useful context with “Running tools.”
A follow-up clears the previous narrative. Without useful context, the floating
bar stays hidden. Chat never inserts a generic “Thinking” placeholder.

Held tool previews clear when the bar hides, the chat changes, or work ends.
They do not alter tool state or retained transcript history. Original transcript
content remains available for copying and search.

Elapsed time uses the recorded turn start, with a local start as a fallback.
It survives tool changes and returning to the bottom, and resets for a new turn.
Only the visible inline status ticks once per second; it does not rerender the message
list. A broad highlight travels left to right across “Working,” with a one-second
sweep every four seconds after a 600 ms initial delay, following Codex's
`summary_shimmer.rs`. The elapsed text stays steady. Shimmer and spinner respect
reduced motion.

Prompt context follows Codex CLI's `transcript_view/prompt_header.rs`. Reasoning
summary formatting follows `chatwidget/streaming.rs` and elapsed status follows
`status_indicator_widget.rs`; Codex renders its status
separately from the scrolled transcript in `chatwidget/rendering.rs`. These were
inspected in the refreshed checkout at `89461ea6833832b0551ce24ee32205824d5c108d`.

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
