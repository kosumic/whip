#!/usr/bin/env ruby
# Actual UIKit/WebKit touch arbitration, using only thin arm64 simulator builds.
require 'fileutils'
require 'xcodeproj'

abort 'iOS session navigation tests require macOS' unless RUBY_PLATFORM.include?('darwin')
root = File.expand_path('..', __dir__)
build = File.join(root, 'build', 'ios-session-navigation-tests')
FileUtils.mkdir_p(build)
project = Xcodeproj::Project.new(File.join(build, 'SessionNavigationTests.xcodeproj'))
host = project.new_target(:application, 'SessionNavigationTestHost', :ios, '16.4')
host.add_system_frameworks(%w[UIKit WebKit])
%w[modules/whip-session-navigation/ios/SessionExitGesture.swift ios/Tests/SessionNavigationTestHost.swift].each do |path|
  host.source_build_phase.add_file_reference(project.main_group.new_file(File.join(root, path)))
end
tests = project.new_target(:ui_test_bundle, 'SessionNavigationUITests', :ios, '16.4')
tests.add_dependency(host)
tests.add_system_frameworks(['XCTest'])
tests.source_build_phase.add_file_reference(project.main_group.new_file(File.join(root, 'ios/Tests/SessionNavigationUITests.swift')))
[host, tests].each do |target|
  target.build_configurations.each do |config|
    config.build_settings.merge!({
      'ARCHS' => 'arm64', 'ONLY_ACTIVE_ARCH' => 'YES',
      'SWIFT_VERSION' => '5.9', 'GENERATE_INFOPLIST_FILE' => 'YES',
      'INFOPLIST_KEY_UILaunchScreen_Generation' => 'YES',
      'PRODUCT_BUNDLE_IDENTIFIER' => "io.github.kaminarios.whip.#{target.name.downcase}",
      'CODE_SIGNING_ALLOWED' => 'NO'
    })
  end
end
tests.build_configurations.each do |config|
  config.build_settings['TEST_TARGET_NAME'] = host.name
end
unit = project.new_target(:unit_test_bundle, 'SessionExitGestureTests', :ios, '16.4')
unit.add_dependency(host)
unit.add_system_frameworks(%w[UIKit XCTest])
unit.source_build_phase.add_file_reference(project.main_group.new_file(File.join(root, 'ios/Tests/SessionExitGestureTests.swift')))
unit.build_configurations.each do |config|
  config.build_settings.merge!({
    'ARCHS' => 'arm64', 'ONLY_ACTIVE_ARCH' => 'YES', 'SWIFT_VERSION' => '5.9',
    'GENERATE_INFOPLIST_FILE' => 'YES', 'CODE_SIGNING_ALLOWED' => 'NO',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'io.github.kaminarios.whip.session-exit-tests',
    'TEST_HOST' => '$(BUILT_PRODUCTS_DIR)/SessionNavigationTestHost.app/SessionNavigationTestHost',
    'BUNDLE_LOADER' => '$(TEST_HOST)'
  })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(host, tests)
scheme.add_test_target(unit)
scheme.save_as(project.path, 'SessionNavigationTests', true)
ENV['DEVELOPER_DIR'] = '/Applications/Xcode.app/Contents/Developer'
ENV['PATH'] = "/usr/bin:/bin:/usr/sbin:/sbin:#{ENV['PATH']}"
ENV.delete_if { |name, _| name.start_with?('NIX_') || %w[SDKROOT CC CXX CPP LD LDPLUSPLUS AR AS NM RANLIB STRIP LIPO LIBTOOL].include?(name) }
exec('/usr/bin/xcodebuild', '-project', project.path.to_s, '-scheme', 'SessionNavigationTests',
     '-sdk', 'iphonesimulator', '-destination', ENV.fetch('WHIP_IOS_TEST_DESTINATION', 'platform=iOS Simulator,name=iPhone 17 Pro'),
     '-derivedDataPath', File.join(build, 'DerivedData'), '-parallel-testing-enabled', 'NO', 'test', *ARGV)
