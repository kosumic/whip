package io.github.kaminarios.whip.spinner

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.BridgeReactContext
import expo.modules.core.ModuleRegistry
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.modules.Module
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

private const val SPINNER_SIZE = 96

class SpinnerTestActivity : AppCompatActivity() {
  lateinit var spinner: WhipAgentSpinnerView
  private lateinit var react: BridgeReactContext

  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(androidx.appcompat.R.style.Theme_AppCompat)
    super.onCreate(savedInstanceState)
    react = BridgeReactContext(application)
    val provider = object : ModulesProvider {
      override fun getModulesMap() = emptyMap<Class<out Module>, String?>()
    }
    val appContext = AppContext(provider, ModuleRegistry(emptyList(), emptyList()), WeakReference(react))
    spinner = WhipAgentSpinnerView(this, appContext)
    setContentView(spinner, android.widget.FrameLayout.LayoutParams(SPINNER_SIZE, SPINNER_SIZE))
  }

  override fun onResume() {
    super.onResume()
    react.onHostResume(this)
  }

  override fun onPause() {
    react.onHostPause()
    super.onPause()
  }
}

@RunWith(AndroidJUnit4::class)
class SpinnerLifecycleTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()

  private fun pixels(view: WhipAgentSpinnerView): Bitmap {
    lateinit var bitmap: Bitmap
    instrumentation.runOnMainSync {
      bitmap = Bitmap.createBitmap(SPINNER_SIZE, SPINNER_SIZE, Bitmap.Config.ARGB_8888)
      view.draw(Canvas(bitmap))
    }
    return bitmap
  }

  private fun frames(count: Int = 3) {
    val ready = CountDownLatch(1)
    instrumentation.runOnMainSync {
      var remaining = count
      val callback = object : Choreographer.FrameCallback {
        override fun doFrame(time: Long) {
          remaining--
          if (remaining == 0) ready.countDown() else Choreographer.getInstance().postFrameCallback(this)
        }
      }
      Choreographer.getInstance().postFrameCallback(callback)
    }
    assertTrue("Visible test activity receives native frames", ready.await(3, TimeUnit.SECONDS))
  }

  private fun awaitForeground(activity: SpinnerTestActivity) {
    val deadline = SystemClock.uptimeMillis() + 5000
    var visible = false
    while (!visible && SystemClock.uptimeMillis() < deadline) {
      instrumentation.runOnMainSync {
        visible = activity.hasWindowFocus() && activity.spinner.windowVisibility == View.VISIBLE
      }
      if (!visible) SystemClock.sleep(10)
    }
    assertTrue("Test activity is visibly foregrounded", visible)
  }

  @Test fun repeatedRealAppSwitchesResumeWithoutJavaScriptAndHonorDisable() {
    val intent = Intent(instrumentation.targetContext, SpinnerTestActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val activity = instrumentation.startActivitySync(intent) as SpinnerTestActivity
    try {
      awaitForeground(activity)
      frames()
      val initial = pixels(activity.spinner)
      frames()
      assertFalse("Spinner rotates on a physical display", initial.sameAs(pixels(activity.spinner)))
      repeat(3) {
        instrumentation.runOnMainSync { activity.moveTaskToBack(true) }
        SystemClock.sleep(200)
        val paused = pixels(activity.spinner)
        SystemClock.sleep(200)
        assertTrue("Background bitmap remains stationary", paused.sameAs(pixels(activity.spinner)))
        val started = SystemClock.uptimeMillis()
        instrumentation.targetContext.startActivity(intent)
        awaitForeground(activity)
        frames()
        assertFalse("Resume needs no JS enabled update", paused.sameAs(pixels(activity.spinner)))
        Log.i("WhipSpinnerTest", "Foreground to three native frames: ${SystemClock.uptimeMillis() - started} ms")
      }
      instrumentation.runOnMainSync { activity.spinner.setAnimationEnabled(false) }
      val disabled = pixels(activity.spinner)
      instrumentation.runOnMainSync { activity.moveTaskToBack(true) }
      SystemClock.sleep(200)
      instrumentation.targetContext.startActivity(intent)
      awaitForeground(activity)
      frames()
      assertTrue("Foregrounding honors explicit disable", disabled.sameAs(pixels(activity.spinner)))
      instrumentation.runOnMainSync {
        activity.spinner.setAnimationEnabled(true)
        activity.spinner.visibility = View.INVISIBLE
      }
      val hidden = pixels(activity.spinner)
      frames()
      assertTrue("Hidden spinners remain suspended", hidden.sameAs(pixels(activity.spinner)))
      instrumentation.runOnMainSync { activity.spinner.visibility = View.VISIBLE }
      frames()
      assertFalse("Visible spinners resume", hidden.sameAs(pixels(activity.spinner)))
    } finally {
      instrumentation.runOnMainSync { activity.finish() }
    }
  }
}
