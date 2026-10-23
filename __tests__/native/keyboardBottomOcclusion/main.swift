import Foundation
import CoreGraphics

let portrait = CGRect(x: 0, y: 0, width: 1024, height: 1366)
let landscape = CGRect(x: 0, y: 0, width: 1366, height: 1024)
let cases: [(String, CGRect, CGRect, CGFloat)] = [
  ("iPad docked", CGRect(x: 0, y: 1000, width: 1024, height: 366), portrait, 366),
  ("floating interior", CGRect(x: 400, y: 600, width: 320, height: 260), portrait, 0),
  ("floating touching bottom", CGRect(x: 400, y: 1106, width: 320, height: 260), portrait, 0),
  ("undocked full width", CGRect(x: 0, y: 700, width: 1024, height: 366), portrait, 0),
  ("hardware keyboard", CGRect(x: 0, y: 1366, width: 1024, height: 0), portrait, 0),
  ("offscreen keyboard", CGRect(x: 0, y: 1366, width: 1024, height: 366), portrait, 0),
  ("interactive dismissal", CGRect(x: 0, y: 1200, width: 1024, height: 366), portrait, 166),
  ("landscape", CGRect(x: 0, y: 700, width: 1366, height: 324), landscape, 324),
  ("window coordinates", CGRect(x: 0, y: 600, width: 600, height: 200), CGRect(x: 0, y: 0, width: 600, height: 800), 200),
  ("iPhone safe area included once", CGRect(x: 0, y: 500, width: 390, height: 344), CGRect(x: 0, y: 0, width: 390, height: 844), 344),
]
for (label, frame, window, expected) in cases {
  let actual = keyboardFrameBottomOcclusion(frame: frame, in: window)
  precondition(actual == expected, "\(label): expected \(expected), got \(actual)")
}
print("Passed \(cases.count) native keyboard bottom occlusion cases")
