#!/usr/bin/env ruby
# Drives an already-installed experimental Release app; no Metro or Rust rebuild.
require 'fileutils'
require 'xcodeproj'

abort 'Native Shell iOS UI tests require macOS' unless RUBY_PLATFORM.include?('darwin')
root = File.expand_path('..', __dir__)
build = File.expand_path(ENV.fetch('WHIP_NSH_UI_BUILD_DIRECTORY', 'build/ios-nsh-about-tests'), root)
FileUtils.mkdir_p(build)
project = Xcodeproj::Project.new(File.join(build, 'NshUITests.xcodeproj'))
target = project.new_target(:ui_test_bundle, 'NshAboutUITests', :ios, '16.4')
target.add_system_frameworks(%w[UIKit XCTest])
source = File.join(root, 'packages/whip-nsh/tests/ios/WhipNshAboutUITests.m')
target.source_build_phase.add_file_reference(project.main_group.new_file(source))
target.build_configurations.each do |config|
  config.build_settings.merge!({
    'ARCHS' => 'arm64', 'ONLY_ACTIVE_ARCH' => 'YES', 'CLANG_ENABLE_OBJC_ARC' => 'YES',
    'GENERATE_INFOPLIST_FILE' => 'YES', 'CODE_SIGNING_ALLOWED' => 'NO',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'io.github.kaminarios.whip.nsh-about-ui-tests',
    'TARGETED_DEVICE_FAMILY' => '1,2'
  })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.add_test_target(target)
scheme.save_as(project.path, 'NshAboutUITests', true)
ENV['DEVELOPER_DIR'] ||= '/Applications/Xcode.app/Contents/Developer'
ENV['PATH'] = "/usr/bin:/bin:/usr/sbin:/sbin:#{ENV['PATH']}"
ENV.delete_if { |name, _| name.start_with?('NIX_') || %w[SDKROOT CC CXX CPP LD LDPLUSPLUS AR AS NM RANLIB STRIP LIPO LIBTOOL].include?(name) }
exec('/usr/bin/xcodebuild', '-project', project.path.to_s, '-scheme', 'NshAboutUITests',
     '-sdk', 'iphonesimulator', '-destination', ENV.fetch('WHIP_IOS_TEST_DESTINATION', 'platform=iOS Simulator,name=Whip Input CI'),
     '-derivedDataPath', File.join(build, 'DerivedData'), '-jobs', '1', '-parallel-testing-enabled', 'NO',
     'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', 'test', *ARGV)
