# GPT-Live command rejection and call lifetime

The previous provider driver returned an error for every GPT-Live `error` event,
including after `session.started`. Whip consequently stopped the native call and
showed a generic session-command failure for an individual rejected command.

The installed ChatGPT APK provided a reference for separating error reporting
from call disconnection. In its recovered `z571.s` transcript-delta path, an
exception is reported through a typed error bucket and the method returns;
disconnect reasons and cancellation decisions are handled elsewhere. This is
evidence of separate lifecycle responsibilities, not proof that ChatGPT uses
the same public GPT-Live protocol or handles every command error identically.
Local evidence: `artifacts/chatgpt-voice-analysis/targeted/z571.java`, methods
`s` and `h0`, in the installed-build audit.

The public [GPT-Live lifecycle documentation](https://developers.openai.com/api/docs/guides/live-conversations#handle-errors-and-end-the-session)
distinguishes rejected commands, speech interruptions, connection failures, and
closed sessions. Some moderation events stop a speech segment while retaining
the session; others close it. An error alone does not establish closure.

Whip now forwards nonterminal errors during established calls as warnings while
retaining input, subsequent speech, and usage/finalization events. It never
resends rejected commands. Startup/account failures and a rejection matching
the pending microphone control remain terminal. A content-closed session is
honored without automatic network recovery. A rejected global backend create
releases only its matching pending slot and cannot start its own retry.

Diagnostics retain bounded type/code/parameter identifiers and consistent,
app-owned client event IDs. Provider prose, audio, transcripts, and credentials
are excluded from these diagnostics. The view and Android logs expose the last
diagnostic and count; a safe rejection event is retained in call history.

The screenshot's generic message confirms Whip took its old fatal error path.
Its specific provider code was unavailable in the retained Android log window;
the screenshot's text does not establish a moderation or copyright error.
Offline regressions cover continued speech/final usage after rejection, absent
codes, account failures, rejected unmute, command correlation, and no replay.
