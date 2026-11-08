# Voice call piano cues

Created by dVidrio02 and released under CC0 1.0 Universal:
https://creativecommons.org/publicdomain/zero/1.0/

- `voice-ready.mp3`: Text Tone 5, https://freesound.org/people/dVidrio02/sounds/636401/
- `voice-closed.mp3`: Text Tone 4, https://freesound.org/people/dVidrio02/sounds/636397/

These are the unmodified high-quality MP3 previews supplied by Freesound.
They may be copied, modified, and distributed, including commercially, without
attribution. Both files are bundled with the app; playback makes no network
requests.

Voice chat plays the ready cue once after its first recognizer is listening,
and the closed cue after an activated call hangs up. Minimizing or reopening
the screen does not play either cue. An audio interruption suppresses the
closing cue so it cannot play over another call.

## Offline microphone announcements (#389)

`voice-muted.wav` and `voice-unmuted.wav` say “Muted” and “Unmuted”. They were
generated locally with eSpeak NG's `en-us` voice at 160 words/minute and converted
with SoX to 24 kHz mono PCM16. They are embedded in the Rust call owner and played natively;
they require no model, download, API key or network request.

To regenerate, in `nix develop`, run for each word (`Muted` and `Unmuted`):

```bash
nix shell nixpkgs#espeak-ng nixpkgs#sox -c bash -c \
  'espeak-ng -v en-us -s 160 -w /tmp/whip-muted.wav Muted && sox /tmp/whip-muted.wav -r 24000 -c 1 -b 16 assets/audio/voice-muted.wav'
```
