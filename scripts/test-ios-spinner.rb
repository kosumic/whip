#!/usr/bin/env ruby
# Standalone UIKit tests compile the production spinner and patched Worklets
# scheduler. Only the Expo/RN wrappers are stubbed; animation uses real UIKit.
require 'fileutils'
require 'xcodeproj'

abort 'iOS spinner tests require macOS' unless RUBY_PLATFORM.include?('darwin')
root = File.expand_path('..', __dir__)
build = File.join(root, 'build', 'ios-spinner-tests')
headers = File.join(build, 'Headers')
FileUtils.mkdir_p(build)
def write(path, body)
  FileUtils.mkdir_p(File.dirname(path))
  File.write(path, body)
end
write(File.join(build, 'ExpoView.swift'), <<~SWIFT)
  import UIKit
  public class AppContext {}
  open class ExpoView: UIView {
    public required init(appContext: AppContext? = nil) { super.init(frame: .zero) }
    @available(*, unavailable)
    public required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
  }
SWIFT
write(File.join(headers, 'React', 'RCTUtils.h'), <<~OBJC)
  #pragma once
  #import <Foundation/Foundation.h>
  inline bool RCTIsMainQueue() { return NSThread.isMainThread; }
  inline void RCTUnsafeExecuteOnMainQueueSync(dispatch_block_t block) {
    if (RCTIsMainQueue()) block(); else dispatch_sync(dispatch_get_main_queue(), block);
  }
OBJC
write(File.join(headers, 'React', 'RCTAssert.h'), <<~OBJC)
  #import <React/RCTUtils.h>
  #define react_native_assert(condition) NSCAssert(condition, @"React queue assertion")
  #define RCTAssertMainQueue() react_native_assert(RCTIsMainQueue())
OBJC
%w[AssertJavaScriptQueue AssertTurboModuleManagerQueue].each do |name|
  function = name == 'AssertJavaScriptQueue' ? 'inline bool IsJavaScriptQueue() { return true; }' : 'inline void AssertTurboModuleManagerQueue() {}'
  write(File.join(headers, 'worklets', 'apple', "#{name}.h"), <<~CPP)
    #pragma once
    #include <vector>
    #include <mutex>
    #{function}
  CPP
end
write(File.join(headers, 'worklets', 'Tools', 'FeatureFlags.h'), <<~CPP)
  #pragma once
  namespace worklets { struct StaticFeatureFlags {
    static constexpr bool getFlag(const char *) { return false; }
  }; }
CPP
write(File.join(headers, 'worklets', 'apple', 'SlowAnimations.h'), <<~CPP)
  #import <QuartzCore/QuartzCore.h>
  namespace worklets { inline CFTimeInterval calculateTimestampWithSlowAnimations(CFTimeInterval t) { return t; } }
CPP
worklets = File.join(root, 'node_modules', 'react-native-worklets', 'apple', 'worklets', 'apple')
%w[AnimationFrameQueue.h WorkletsDisplayLink.h].each do |name|
  FileUtils.ln_sf(File.join(worklets, name), File.join(headers, 'worklets', 'apple', name))
end
project = Xcodeproj::Project.new(File.join(build, 'SpinnerTests.xcodeproj'))
host = project.new_target(:application, 'SpinnerTestHost', :ios, '16.4')
host.source_build_phase.add_file_reference(project.main_group.new_file(File.join(root, 'ios', 'Tests', 'BrowserTestHost.m')))
expo = project.new_target(:framework, 'ExpoModulesCore', :ios, '16.4')
expo.source_build_phase.add_file_reference(project.main_group.new_file(File.join(build, 'ExpoView.swift')))
expo.build_configurations.each do |config|
  config.build_settings.merge!('MACH_O_TYPE' => 'staticlib', 'DEFINES_MODULE' => 'YES')
end
tests = project.new_target(:unit_test_bundle, 'SpinnerTests', :ios, '16.4')
tests.add_dependency(host)
tests.add_dependency(expo)
tests.frameworks_build_phase.add_file_reference(expo.product_reference)
tests.add_system_frameworks(%w[UIKit QuartzCore XCTest])
[
  ENV.fetch('WHIP_SPINNER_TEST_SOURCE', File.join(root, 'modules/whip-native-spinner/ios/WhipAgentSpinnerView.swift')),
  File.join(root, 'ios/Tests/WhipAgentSpinnerTests.swift'),
  File.join(root, 'ios/Tests/WhipAnimationFrameQueueTests.mm'),
  ENV.fetch('WHIP_FRAME_QUEUE_TEST_SOURCE', File.join(worklets, 'AnimationFrameQueue.mm'))
].each { |path| tests.source_build_phase.add_file_reference(project.main_group.new_file(path)) }
[host, expo, tests].each do |target|
  target.build_configurations.each do |config|
    config.build_settings.merge!({
      'ARCHS' => 'arm64', 'ONLY_ACTIVE_ARCH' => 'YES',
      'SWIFT_VERSION' => '5.0', 'CLANG_ENABLE_OBJC_ARC' => 'YES',
      'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20', 'GENERATE_INFOPLIST_FILE' => 'YES',
      'PRODUCT_BUNDLE_IDENTIFIER' => "io.github.kaminarios.whip.#{target.name.downcase}",
      'HEADER_SEARCH_PATHS' => headers, 'CODE_SIGNING_ALLOWED' => 'NO'
    })
  end
end
tests.build_configurations.each do |config|
  config.build_settings.merge!({
    'TEST_HOST' => '$(BUILT_PRODUCTS_DIR)/SpinnerTestHost.app/SpinnerTestHost',
    'BUNDLE_LOADER' => '$(TEST_HOST)'
  })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(host, tests)
scheme.save_as(project.path, 'SpinnerTests', true)
ENV['DEVELOPER_DIR'] = '/Applications/Xcode.app/Contents/Developer'
ENV['PATH'] = "/usr/bin:/bin:/usr/sbin:/sbin:#{ENV['PATH']}"
ENV.delete_if { |name, _| name.start_with?('NIX_') || %w[SDKROOT CC CXX CPP LD LDPLUSPLUS AR AS NM RANLIB STRIP LIPO LIBTOOL].include?(name) }
exec('/usr/bin/xcodebuild', '-project', project.path.to_s, '-scheme', 'SpinnerTests',
     '-sdk', 'iphonesimulator', '-destination', ENV.fetch('WHIP_IOS_TEST_DESTINATION', 'platform=iOS Simulator,name=iPhone 17 Pro'),
     '-derivedDataPath', File.join(build, 'DerivedData'), '-parallel-testing-enabled', 'NO', 'test', *ARGV)
