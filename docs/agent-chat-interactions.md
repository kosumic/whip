# Inline agent prompts

Live chat shows a prompt card when Herdr reports the selected Codex, Claude Code,
or OpenCode pane as blocked. Rust reads the visible terminal screen as plain text;
transcript history does not authorize input. Saved, hidden, and stale chats have
no interactive controls.

Codex's queued follow-up notice appears as a compact question count and an
**Answer question** button. The button sends Shift+Enter to open the CLI dialog;
it does not submit an answer to the normal composer. Once the dialog is visible,
the next live read replaces the notice with the question and its choices.

Numbered menus with one visible cursor become selectable buttons using the
agent's actual labels. Selecting a button moves the terminal cursor; **Confirm
selection** sends Enter. This keeps approval scope visible, including choices
that grant permission for future commands. Question text and choice buttons are
shown once, without the CLI composer, model details, or shortcut footer.
**Cancel** sends Escape. **Show terminal controls** reveals the full live screen,
Arrow, Tab, and Space controls for question pages and multiple selection, and a
text field that sends one plain-text line followed by Enter. Unrecognized dialogs
use a compact waiting message with the same disclosure and Terminal fallback.

Before each response, Rust checks a fresh server snapshot, the chat binding,
agent session, connection generation, and current visible screen revision. A
changed prompt is rejected and refreshed. Submissions are serialized and reserved
before dispatch; they are never automatically replayed after a lost acknowledgement.
The Terminal button remains available for dialogs that need other keys.

This uses the existing terminal transport, not agent-specific request APIs.
Background asynchronous questions are only interactive here when their CLI
displays a dialog and Herdr reports the pane as blocked. Non-numbered menus remain
usable through the navigation controls. Herdr currently has no atomic
compare-screen-and-send endpoint: another client can change the pane between the
last read and the write, so concurrent terminal input should be avoided while
answering a prompt in chat.

Validation:

```sh
nix develop -c cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib
nix develop -c node_modules/.bin/jest --runInBand --runTestsByPath __tests__/agentInteractionControls.test.tsx
nix develop -c node_modules/.bin/tsc --noEmit
```
