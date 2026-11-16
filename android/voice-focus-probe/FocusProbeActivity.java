package io.github.kaminarios.whip.focusprobe;

import android.app.Activity;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.TextView;

/** A separate focus owner: no microphone, provider credentials, or app data. */
public final class FocusProbeActivity extends Activity {
  private final Handler main = new Handler(Looper.getMainLooper());
  private AudioFocusRequest request;
  private AudioManager audio;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    String mode = getIntent().getStringExtra("mode");
    int gain = "permanent".equals(mode) ? AudioManager.AUDIOFOCUS_GAIN
        : "duck".equals(mode) ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
        : AudioManager.AUDIOFOCUS_GAIN_TRANSIENT;
    TextView label = new TextView(this);
    label.setText("Audio focus probe: " + mode + "\nReturning to Whip in 3 seconds.");
    setContentView(label);
    audio = getSystemService(AudioManager.class);
    request = new AudioFocusRequest.Builder(gain)
        .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener(change -> Log.i("WhipFocusProbe", "event=focus change=" + change), main)
        .build();
    // Focus acquisition requires a resumed foreground activity on Android 15+.
    main.postDelayed(() -> {
      Log.i("WhipFocusProbe", "event=request gain=" + gain + " result=" + audio.requestAudioFocus(request));
      main.postDelayed(this::finish, 3000);
    }, 200);
  }

  @Override public void onDestroy() {
    main.removeCallbacksAndMessages(null);
    if (audio != null && request != null) audio.abandonAudioFocusRequest(request);
    Log.i("WhipFocusProbe", "event=release");
    super.onDestroy();
  }
}
