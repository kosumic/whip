import ExpoModulesCore
import UIKit

public final class WhipAgentSpinnerView: ExpoView {
  private static let animationKey = "whip-agent-spinner-rotation"
  private static let trailOpacities: [CGFloat] = [1, 0.72, 0.5, 0.32, 0.16]
  private static let positionCount = 10

  private let spinnerLayer = CALayer()
  private let dotLayers = trailOpacities.map { _ in CAShapeLayer() }
  private var animationEnabled = true
  private var rotationDuration = 0.7
  private var framesPerSecond: Float = 60
  private var spinnerColor = UIColor.white
  private var appActive = UIApplication.shared.applicationState == .active
  private var rotationPhase = 0.0
  private var startedAt: CFTimeInterval?

  public override var isHidden: Bool {
    didSet { updateAnimationState() }
  }

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    isUserInteractionEnabled = false
    layer.addSublayer(spinnerLayer)
    dotLayers.forEach { spinnerLayer.addSublayer($0) }
    NotificationCenter.default.addObserver(
      self, selector: #selector(appDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification, object: nil
    )
    NotificationCenter.default.addObserver(
      self, selector: #selector(appWillResignActive),
      name: UIApplication.willResignActiveNotification, object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  @objc private func appDidBecomeActive() {
    appActive = true
    updateAnimationState()
  }

  @objc private func appWillResignActive() {
    appActive = false
    updateAnimationState()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    spinnerLayer.frame = bounds
    layoutDots()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    updateAnimationState()
  }

  public func setSpinnerColor(_ color: UIColor) {
    spinnerColor = color
    updateDotColors()
  }

  public func setRotationDuration(_ durationMs: Double) {
    let nextDuration = max(durationMs, 100) / 1000
    guard rotationDuration != nextDuration else { return }
    stopAnimation()
    rotationDuration = nextDuration
    updateAnimationState()
  }

  public func setAnimationEnabled(_ enabled: Bool) {
    guard animationEnabled != enabled else { return }
    animationEnabled = enabled
    updateAnimationState()
  }

  public func setFramesPerSecond(_ value: Float) {
    let nextFrameRate = min(max(value, 1), 120)
    guard framesPerSecond != nextFrameRate else { return }
    stopAnimation()
    framesPerSecond = nextFrameRate
    updateAnimationState()
  }

  private func layoutDots() {
    let extent = min(bounds.width, bounds.height)
    guard extent > 0 else { return }

    let center = CGPoint(x: bounds.midX, y: bounds.midY)
    let orbitRadius = extent * 9.5 / 24
    let dotRadius = extent * 2 / 24

    for (index, dotLayer) in dotLayers.enumerated() {
      let angle = -CGFloat.pi / 2 - CGFloat(index) * 2 * CGFloat.pi / CGFloat(Self.positionCount)
      let dotCenter = CGPoint(
        x: center.x + cos(angle) * orbitRadius,
        y: center.y + sin(angle) * orbitRadius
      )
      dotLayer.path = UIBezierPath(
        ovalIn: CGRect(
          x: dotCenter.x - dotRadius,
          y: dotCenter.y - dotRadius,
          width: dotRadius * 2,
          height: dotRadius * 2
        )
      ).cgPath
    }
    updateDotColors()
  }

  private func updateDotColors() {
    for (index, dotLayer) in dotLayers.enumerated() {
      dotLayer.fillColor = spinnerColor
        .withAlphaComponent(Self.trailOpacities[index])
        .cgColor
    }
  }

  private func updateAnimationState() {
    if animationEnabled && appActive && window != nil && !isHidden {
      if spinnerLayer.animation(forKey: Self.animationKey) == nil {
        startAnimation()
      }
    } else {
      stopAnimation()
    }
  }

  private func startAnimation() {
    startedAt = CACurrentMediaTime()
    let animation = CABasicAnimation(keyPath: "transform.rotation.z")
    animation.fromValue = rotationPhase * .pi * 2
    animation.toValue = (rotationPhase + 1) * .pi * 2
    animation.duration = rotationDuration
    animation.preferredFrameRateRange = CAFrameRateRange(
      minimum: framesPerSecond,
      maximum: framesPerSecond,
      preferred: framesPerSecond
    )
    animation.repeatCount = .infinity
    animation.timingFunction = CAMediaTimingFunction(name: .linear)
    animation.isRemovedOnCompletion = false
    spinnerLayer.add(animation, forKey: Self.animationKey)
  }

  private func stopAnimation() {
    if let startedAt {
      rotationPhase = (rotationPhase + (CACurrentMediaTime() - startedAt) / rotationDuration)
        .truncatingRemainder(dividingBy: 1)
    }
    startedAt = nil
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    spinnerLayer.removeAnimation(forKey: Self.animationKey)
    spinnerLayer.setValue(rotationPhase * .pi * 2, forKeyPath: "transform.rotation.z")
    CATransaction.commit()
  }
}
