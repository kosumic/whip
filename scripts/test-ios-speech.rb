#!/usr/bin/env ruby
# Run with: nix develop -c ruby scripts/test-ios-speech.rb
# Standalone speech adapter tests script Rust admission and native engine callbacks.
require 'fileutils'
require 'xcodeproj'

abort 'iOS speech tests require macOS' unless RUBY_PLATFORM.include?('darwin')
action = ARGV.delete('--build-only') ? 'build-for-testing' : 'test'
root = File.expand_path('..', __dir__)
build = File.join(root, 'build', 'ios-speech-tests')
FileUtils.mkdir_p(build)
headers = File.join(build, 'Headers')
FileUtils.mkdir_p(headers)
react = File.join(root, 'node_modules', 'react-native')
{
  'RCTDeprecation' => File.join(react, 'ReactApple', 'Libraries', 'RCTFoundation', 'RCTDeprecation', 'Exported')
}.each do |name, path|
  link = File.join(headers, name)
  File.unlink(link) if File.symlink?(link)
  FileUtils.ln_s(path, link)
end
react_headers = File.join(headers, 'React')
File.unlink(react_headers) if File.symlink?(react_headers)
FileUtils.mkdir_p(react_headers)
(Dir[File.join(react, 'React', 'Base', '*.h')] + [File.join(react, 'React', 'Modules', 'RCTEventEmitter.h')]).each do |path|
  FileUtils.ln_sf(path, File.join(react_headers, File.basename(path)))
end
project = Xcodeproj::Project.new(File.join(build, 'SpeechTests.xcodeproj'))
host = project.new_target(:application, 'SpeechTestHost', :ios, '16.4')
host.add_system_frameworks(['UIKit'])
host.source_build_phase.add_file_reference(project.main_group.new_file(File.join(root, 'ios', 'Tests', 'BrowserTestHost.m')))
host.build_configurations.each do |config|
  config.build_settings.merge!({
    'ARCHS' => 'arm64', 'ONLY_ACTIVE_ARCH' => 'YES', 'CLANG_ENABLE_OBJC_ARC' => 'YES',
    'GENERATE_INFOPLIST_FILE' => 'YES', 'INFOPLIST_KEY_UILaunchScreen_Generation' => 'YES',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'io.github.kaminarios.whip.speech-test-host',
    'CODE_SIGNING_ALLOWED' => 'NO'
  })
end
target = project.new_target(:unit_test_bundle, 'SpeechTests', :ios, '16.4')
target.add_dependency(host)
target.add_system_frameworks(%w[UIKit AVFoundation CoreMotion UserNotifications XCTest])
%w[ios/HerdR/WhipSpeechPlayback.m ios/Tests/WhipSpeechPlaybackTests.m].each do |path|
  target.source_build_phase.add_file_reference(project.main_group.new_file(File.join(root, path)))
end
target.build_configurations.each do |config|
  config.build_settings.merge!({
    'ARCHS' => 'arm64',
    'ONLY_ACTIVE_ARCH' => 'YES',
    'CLANG_ENABLE_OBJC_ARC' => 'YES',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'io.github.kaminarios.whip.speech-tests',
    'TEST_HOST' => '$(BUILT_PRODUCTS_DIR)/SpeechTestHost.app/SpeechTestHost',
    'BUNDLE_LOADER' => '$(TEST_HOST)',
    'GCC_PREPROCESSOR_DEFINITIONS' => ['$(inherited)', 'RCT_REMOVE_LEGACY_ARCH=1'],
    'HEADER_SEARCH_PATHS' => [
      File.join(root, 'ios', 'HerdR'),
      File.join(root, 'packages', 'react-native-whip-ssh', 'ios'),
      headers
    ],
    'CODE_SIGNING_ALLOWED' => 'NO'
  })
end
native = project.new_target(:static_library, 'VoiceAdapterCompile', :ios, '16.4')
native.add_system_frameworks(%w[UIKit AVFoundation CallKit Security])
%w[WhipVoiceCall.mm WhipRealtimeVoice.mm].each do |name|
  native.source_build_phase.add_file_reference(project.main_group.new_file(File.join(root, 'packages', 'react-native-whip-ssh', 'ios', name)))
end
native.source_build_phase.add_file_reference(project.main_group.new_file(File.join(root, 'ios', 'HerdR', 'HerdrBackground.m')))
native.build_configurations.each do |config|
  config.build_settings.merge!({
    'ARCHS' => 'arm64', 'ONLY_ACTIVE_ARCH' => 'YES', 'CLANG_ENABLE_OBJC_ARC' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20', 'CODE_SIGNING_ALLOWED' => 'NO',
    'GCC_PREPROCESSOR_DEFINITIONS' => ['$(inherited)', 'RCT_REMOVE_LEGACY_ARCH=1'],
    'HEADER_SEARCH_PATHS' => [File.join(root, 'ios', 'HerdR'), headers]
  })
end
target.add_dependency(native)
project.save
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(host, target)
scheme.save_as(project.path, 'SpeechTests', true)
ENV['DEVELOPER_DIR'] ||= '/Applications/Xcode.app/Contents/Developer'
ENV['PATH'] = "/usr/bin:/bin:/usr/sbin:/sbin:#{ENV['PATH']}"
ENV.delete_if { |name, _| name.start_with?('NIX_') || %w[SDKROOT CC CXX CPP LD LDPLUSPLUS AR AS NM RANLIB STRIP LIPO LIBTOOL].include?(name) }
exec('/usr/bin/xcodebuild', '-project', project.path.to_s,
     '-scheme', 'SpeechTests', '-sdk', 'iphonesimulator', '-destination', ENV.fetch('WHIP_IOS_TEST_DESTINATION', 'platform=iOS Simulator,name=iPhone 17 Pro'),
     '-derivedDataPath', File.join(build, 'DerivedData'), '-parallel-testing-enabled', 'NO', action, *ARGV)
