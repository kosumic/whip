// Android keyboard input belongs to WhipTerminalInputView. Keep this guard in
// the renderer so a WebView focus change cannot activate xterm's second input
// path. Paste and terminal protocol replies still use terminal.onData.
function installAndroidImeBridge(terminal, _send, userAgent, eventTarget = window) {
  const input = terminal.textarea;
  if (!input || !/Android/i.test(userAgent)) return () => {};

  input.readOnly = true;
  input.inputMode = 'none';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  const stop = event => {
    if (event.target !== input) return;
    event.stopImmediatePropagation();
    if (event.cancelable) event.preventDefault();
  };
  const types = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input',
    'compositionstart', 'compositionupdate', 'compositionend'];
  for (const type of types) eventTarget.addEventListener(type, stop, true);
  return () => {
    for (const type of types) eventTarget.removeEventListener(type, stop, true);
  };
}

module.exports = { installAndroidImeBridge };
