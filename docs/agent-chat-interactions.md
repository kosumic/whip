# Inline agent prompts

Live chat shows a prompt card when Herdr reports the selected Codex, Claude Code,
or OpenCode pane as blocked. Rust reads the visible terminal screen as plain text;
transcript history does not authorize input. Saved, hidden, and stale chats have
no interactive controls.

Numbered menus with one visible cursor become selectable buttons using the
agent's actual labels. Selecting a button moves the terminal cursor; **Confirm
selection** sends Enter. This keeps approval scope visible, including choices
that grant permission for future commands. Arrow, Tab, and Space controls also
handle question pages and multiple selection. **Cancel** sends Escape. The text
field sends a single plain-text line followed by Enter to a dialog accepting text.

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
