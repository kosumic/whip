import Foundation
import React

@objc(WhipBackup)
final class WhipBackup: NSObject {
  private static func preferenceFile() throws -> URL {
    try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("WhipDeviceBackup.json")
  }

  private static func savedChoice() throws -> Bool {
    do {
      return try JSONDecoder().decode(Bool.self, from: Data(contentsOf: preferenceFile()))
    } catch CocoaError.fileReadNoSuchFile {
      let previous = UserDefaults.standard.object(forKey: "WhipDeviceBackupDisabled") as? Bool
      return previous == false
    } catch is DecodingError {
      return false
    }
  }

  @objc static func requiresMainQueueSetup() -> Bool { false }
  @objc var methodQueue: DispatchQueue { .main }

  private static func apply(excluded: Bool) throws {
    for directory in [FileManager.SearchPathDirectory.libraryDirectory, .documentDirectory] {
      var url = try FileManager.default.url(for: directory, in: .userDomainMask, appropriateFor: nil, create: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = excluded
      try url.setResourceValues(values)
    }
  }

  @discardableResult
  static func applySavedPreference() throws -> Bool {
    let enabled = try savedChoice()
    try apply(excluded: !enabled)
    return enabled
  }

  @objc(getDeviceBackupEnabled:reject:)
  func getDeviceBackupEnabled(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    do {
      resolve(try Self.applySavedPreference())
    } catch {
      reject("E_DEVICE_BACKUP", error.localizedDescription, error)
    }
  }

  @objc(setDeviceBackupEnabled:resolve:reject:)
  func setDeviceBackupEnabled(_ enabled: Bool, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    do {
      try Self.apply(excluded: !enabled)
      // Commit before acknowledging so an immediate app update sees the choice.
      try JSONEncoder().encode(enabled).write(to: Self.preferenceFile(), options: .atomic)
      resolve(enabled)
    } catch {
      _ = try? Self.applySavedPreference()
      reject("E_DEVICE_BACKUP", error.localizedDescription, error)
    }
  }
}
