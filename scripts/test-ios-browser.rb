#!/usr/bin/env ruby
# Run with: nix develop -c ruby scripts/test-ios-browser.rb
# Standalone WebKit tests avoid building a simulator Rust/UniFFI library.
require 'fileutils'
require 'xcodeproj'

abort 'iOS browser tests require macOS' unless RUBY_PLATFORM.include?('darwin')
root = File.expand_path('..', __dir__)
build = File.join(root, 'build', 'ios-browser-tests')
FileUtils.mkdir_p(build)
headers = File.join(build, 'Headers')
FileUtils.mkdir_p(headers)
react = File.join(root, 'node_modules', 'react-native')
{
  'React' => File.join(react, 'React', 'Base'),
  'RCTDeprecation' => File.join(react, 'ReactApple', 'Libraries', 'RCTFoundation', 'RCTDeprecation', 'Exported')
}.each do |name, path|
  link = File.join(headers, name)
  File.unlink(link) if File.symlink?(link)
  FileUtils.ln_s(path, link)
end
project = Xcodeproj::Project.new(File.join(build, 'BrowserTests.xcodeproj'))
host = project.new_target(:application, 'BrowserTestHost', :ios, '16.4')
host.add_system_frameworks(['UIKit'])
host.source_build_phase.add_file_reference(project.main_group.new_file(File.join(root, 'ios', 'Tests', 'BrowserTestHost.m')))
host.build_configurations.each do |config|
  config.build_settings.merge!({
    'ARCHS' => 'arm64', 'ONLY_ACTIVE_ARCH' => 'YES', 'CLANG_ENABLE_OBJC_ARC' => 'YES',
    'GENERATE_INFOPLIST_FILE' => 'YES', 'INFOPLIST_KEY_UILaunchScreen_Generation' => 'YES',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'io.github.kaminarios.whip.browser-test-host',
    'CODE_SIGNING_ALLOWED' => 'NO'
  })
end
target = project.new_target(:unit_test_bundle, 'BrowserTests', :ios, '16.4')
target.add_dependency(host)
target.add_system_frameworks(%w[UIKit WebKit XCTest])
%w[ios/HerdR/WhipBrowser.m ios/Tests/WhipBrowserTests.m].each do |path|
  target.source_build_phase.add_file_reference(project.main_group.new_file(File.join(root, path)))
end
runtime = File.join(root, 'packages/react-native-whip-ssh/rust/src/reverse_control/browser/dom.js')
target.resources_build_phase.add_file_reference(project.main_group.new_file(runtime))
target.build_configurations.each do |config|
  config.build_settings.merge!({
    'ARCHS' => 'arm64',
    'ONLY_ACTIVE_ARCH' => 'YES',
    'CLANG_ENABLE_OBJC_ARC' => 'YES',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'io.github.kaminarios.whip.browser-tests',
    'TEST_HOST' => '$(BUILT_PRODUCTS_DIR)/BrowserTestHost.app/BrowserTestHost',
    'BUNDLE_LOADER' => '$(TEST_HOST)',
    'GCC_PREPROCESSOR_DEFINITIONS' => ['$(inherited)', 'RCT_REMOVE_LEGACY_ARCH=1'],
    'HEADER_SEARCH_PATHS' => [
      File.join(root, 'ios', 'HerdR'),
      headers
    ],
    'CODE_SIGNING_ALLOWED' => 'NO'
  })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(host, target)
scheme.save_as(project.path, 'BrowserTests', true)
ENV['DEVELOPER_DIR'] ||= '/Applications/Xcode.app/Contents/Developer'
ENV['PATH'] = "/usr/bin:/bin:/usr/sbin:/sbin:#{ENV['PATH']}"
ENV.delete_if { |name, _| name.start_with?('NIX_') || %w[SDKROOT CC CXX CPP LD LDPLUSPLUS AR AS NM RANLIB STRIP LIPO LIBTOOL].include?(name) }
exec('/usr/bin/xcodebuild', '-quiet', '-project', project.path.to_s,
     '-scheme', 'BrowserTests', '-sdk', 'iphonesimulator', '-destination', ENV.fetch('WHIP_IOS_TEST_DESTINATION', 'platform=iOS Simulator,name=iPhone 17 Pro'),
     '-derivedDataPath', File.join(build, 'DerivedData'), '-parallel-testing-enabled', 'NO', 'test')
