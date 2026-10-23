require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'ExpoWhipTerminalInput'
  s.version = package['version']
  s.summary = package['description']
  s.license = { :type => package['license'], :file => '../LICENSE' }
  s.author = package['author']
  s.homepage = package['homepage']
  s.source = { :git => package['repository']['url'] }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.{h,m,swift}'
  s.public_header_files = '*.h'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
