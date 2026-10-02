package io.github.kaminarios.whip.spinner

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.Choreographer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

class WhipAgentSpinnerView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private var animationEnabled = true
  private var rotationDegrees = 0f
  private var rotationDurationMs = DEFAULT_ROTATION_DURATION_MS
  private var framesPerSecond = DEFAULT_FRAMES_PER_SECOND
  private var animationRunning = false
  private var startedAtNanos = 0L
  private var lastFrame = -1L
  private val choreographer = Choreographer.getInstance()
  private val frameCallback = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      if (!animationRunning) return
      if (startedAtNanos == 0L) startedAtNanos = frameTimeNanos
      // Match Reanimated's absolute vsync timestamps so spinners and glows
      // invalidate on the same frames, even when mounted at different times.
      val frame = (frameTimeNanos / NANOS_PER_SECOND.toDouble() * framesPerSecond).toLong()
      if (frame != lastFrame) {
        lastFrame = frame
        val elapsedMs = (frameTimeNanos - startedAtNanos) / NANOS_PER_MILLISECOND.toDouble()
        rotationDegrees = ((elapsedMs % rotationDurationMs) / rotationDurationMs * 360).toFloat()
        invalidate()
      }
      choreographer.postFrameCallback(this)
    }
  }

  init {
    paint.color = Color.WHITE
    setWillNotDraw(false)
  }

  fun setSpinnerColor(color: Int) {
    paint.color = color
    invalidate()
  }

  fun setRotationDuration(durationMs: Long) {
    val nextDuration = durationMs.coerceAtLeast(MIN_ROTATION_DURATION_MS)
    if (rotationDurationMs == nextDuration) return
    rotationDurationMs = nextDuration
    startedAtNanos = 0L
  }

  fun setFramesPerSecond(value: Int) {
    val nextFrameRate = value.coerceIn(1, MAX_FRAMES_PER_SECOND)
    if (framesPerSecond == nextFrameRate) return
    framesPerSecond = nextFrameRate
    lastFrame = -1L
  }

  fun setAnimationEnabled(enabled: Boolean) {
    if (animationEnabled == enabled) return
    animationEnabled = enabled
    updateAnimationState()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    updateAnimationState()
  }

  override fun onDetachedFromWindow() {
    stopAnimation()
    super.onDetachedFromWindow()
  }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    updateAnimationState()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val extent = min(width, height).toFloat()
    if (extent <= 0f) return

    val centerX = width / 2f
    val centerY = height / 2f
    val orbitRadius = extent * ORBIT_RADIUS_RATIO
    val dotRadius = extent * DOT_RADIUS_RATIO
    val baseAlpha = Color.alpha(paint.color)

    canvas.save()
    canvas.rotate(rotationDegrees, centerX, centerY)
    TRAIL_OPACITIES.forEachIndexed { trailIndex, opacity ->
      val angle = -PI / 2.0 - trailIndex * POSITION_ANGLE_RADIANS
      paint.alpha = (baseAlpha * opacity).toInt().coerceIn(0, 255)
      canvas.drawCircle(
        centerX + cos(angle).toFloat() * orbitRadius,
        centerY + sin(angle).toFloat() * orbitRadius,
        dotRadius,
        paint,
      )
    }
    paint.alpha = baseAlpha
    canvas.restore()
  }

  private fun updateAnimationState() {
    if (animationEnabled && isAttachedToWindow && isShown) {
      if (!animationRunning) {
        animationRunning = true
        startedAtNanos = 0L
        lastFrame = -1L
        choreographer.postFrameCallback(frameCallback)
      }
      return
    }

    stopAnimation()
  }

  private fun stopAnimation() {
    animationRunning = false
    choreographer.removeFrameCallback(frameCallback)
    rotationDegrees = 0f
    invalidate()
  }

  private companion object {
    const val DEFAULT_ROTATION_DURATION_MS = 700L
    const val MIN_ROTATION_DURATION_MS = 100L
    const val DEFAULT_FRAMES_PER_SECOND = 30
    const val MAX_FRAMES_PER_SECOND = 120
    const val NANOS_PER_SECOND = 1_000_000_000L
    const val NANOS_PER_MILLISECOND = 1_000_000L
    const val ORBIT_RADIUS_RATIO = 9.5f / 24f
    const val DOT_RADIUS_RATIO = 2f / 24f
    const val POSITION_ANGLE_RADIANS = 2.0 * PI / 10.0
    val TRAIL_OPACITIES = floatArrayOf(1f, 0.72f, 0.5f, 0.32f, 0.16f)
  }
}
