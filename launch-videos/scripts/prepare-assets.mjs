import {access, copyFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const videoRoot = resolve(here, '..');
const targets = [resolve(videoRoot, 'hyperframes/assets')];

const files = [
  ['assets/icon.png', 'icon.png'],
  ['assets/icon.png', 'icon-intro.png'],
  ['assets/icon.png', 'icon-final.png'],
  ['assets/icon.png', 'icon-phone.png'],
  ['assets/icon.png', 'icon-alert.png'],
  ['assets/icon.png', 'icon-handoff.png'],
  ['assets/whip-cyborg-hand-concept.svg', 'whip-mark.svg'],
  ['site/whip-install-qr.png', 'whip-install-qr.png'],
  ['assets/notification-icon.svg', 'notification-icon.svg'],
  ['assets/screenshots/herd.png', 'screens/herd.png'],
  ['assets/screenshots/chat-composer.png', 'screens/chat-composer.png'],
  ['assets/screenshots/terminal.png', 'screens/terminal.png'],
  ['assets/screenshots/remote-files.png', 'screens/remote-files.png'],
  ['assets/screenshots/hosts.png', 'screens/hosts.png'],
  ['assets/screenshots/jump-host-agent-forwarding.png', 'screens/jump-host-agent-forwarding.png'],
  ['launch-videos/source-assets/herdr-desktop.png', 'herdr/desktop.png'],
  ['launch-videos/source-assets/herdr-desktop-live.png', 'herdr/desktop-live.png'],
  ['launch-videos/source-assets/whip-phone-live.png', 'screens/whip-live-herd.png'],
  ['launch-videos/source-assets/whip-phone-terminal-live.png', 'screens/whip-live-terminal.png'],
  ['launch-videos/source-assets/whip-phone-files-live.png', 'screens/whip-live-files.png'],
  ['launch-videos/source-assets/whip-notification-card-live.png', 'screens/whip-notification-card-live.png'],
  ['launch-videos/source-assets/herdr-logo.png', 'herdr/logo.png'],
  ['launch-videos/source-assets/herdr-logo.png', 'herdr/logo-intro.png'],
  ['launch-videos/source-assets/herdr-logo.png', 'herdr/logo-handoff.png'],
  ['launch-videos/source-assets/herdr-sidebar-agents.png', 'herdr/sidebar-agents.png'],
  ['launch-videos/source-assets/agent-codex.svg', 'herdr/agent-codex.svg'],
  ['launch-videos/source-assets/agent-claude.svg', 'herdr/agent-claude.svg'],
  ['launch-videos/source-assets/agent-opencode.svg', 'herdr/agent-opencode.svg'],
  ['launch-videos/source-assets/fonts/MerriweatherSans-Variable.ttf', 'fonts/MerriweatherSans-Variable.ttf'],
  ['launch-videos/source-assets/fonts/MerriweatherSans-OFL.txt', 'fonts/MerriweatherSans-OFL.txt'],
  ['launch-videos/source-assets/brand/github.svg', 'brand/github.svg'],
  ['launch-videos/source-assets/brand/google-play.svg', 'brand/google-play.svg'],
  ['launch-videos/source-assets/brand/apple.svg', 'brand/apple.svg'],
  ['launch-videos/shared/audio/whip-launch.wav', 'audio/whip-launch.wav'],
  ['launch-videos/source-assets/sfx/whip-snap.wav', 'audio/whip-snap.wav'],
  ['launch-videos/source-assets/sfx/sheep-bleat.wav', 'audio/sheep-bleat.wav'],
  ['launch-videos/source-assets/models/pixel-9-pro/scene.gltf', 'models/pixel-9-pro/scene.gltf'],
  ['launch-videos/source-assets/models/pixel-9-pro/scene.bin', 'models/pixel-9-pro/scene.bin'],
  ['launch-videos/source-assets/models/pixel-9-pro/license.txt', 'models/pixel-9-pro/license.txt'],
  ['launch-videos/source-assets/models/iphone-17-pro/iphone-17-pro.glb', 'models/iphone-17-pro/iphone-17-pro.glb'],
  ['launch-videos/source-assets/models/iphone-17-pro/license.txt', 'models/iphone-17-pro/license.txt'],
  ['launch-videos/source-assets/ios/hosts.mp4', 'ios/hosts.mp4'],
  ['launch-videos/source-assets/ios/notification.mp4', 'ios/notification.mp4'],
  ['launch-videos/source-assets/ios/notification-detail.mp4', 'ios/notification-detail.mp4'],
  ['launch-videos/source-assets/ios/herd-status.mp4', 'ios/herd-status.mp4'],
  ['launch-videos/source-assets/ios/herd-final.mp4', 'ios/herd-final.mp4'],
  ['launch-videos/source-assets/ios/terminal.mp4', 'ios/terminal.mp4'],
  ['launch-videos/source-assets/ios/chat-view.mp4', 'ios/chat-view.mp4'],
  ['launch-videos/source-assets/ios/chat-open-tools.mp4', 'ios/chat-open-tools.mp4'],
  ['launch-videos/source-assets/ios/chat-compose-send.mp4', 'ios/chat-compose-send.mp4'],
  ['launch-videos/source-assets/ios/files.mp4', 'ios/files.mp4'],
  ['launch-videos/source-assets/ios/files-changes.mp4', 'ios/files-changes.mp4'],
  ['launch-videos/source-assets/ios/files-diff.mp4', 'ios/files-diff.mp4'],
  ['launch-videos/source-assets/models/laptop/scene.gltf', 'models/laptop/scene.gltf'],
  ['launch-videos/source-assets/models/laptop/scene.bin', 'models/laptop/scene.bin'],
  ['launch-videos/source-assets/models/laptop/license.txt', 'models/laptop/license.txt'],
  ['launch-videos/source-assets/models/laptop/textures/ComputerFrame_baseColor.png', 'models/laptop/textures/ComputerFrame_baseColor.png'],
  ['launch-videos/source-assets/models/laptop/textures/ComputerFrame_emissive.png', 'models/laptop/textures/ComputerFrame_emissive.png'],
  ['launch-videos/source-assets/models/laptop/textures/ComputerScreen_baseColor.png', 'models/laptop/textures/ComputerScreen_baseColor.png'],
  ['launch-videos/source-assets/models/laptop/textures/ComputerScreen_emissive.png', 'models/laptop/textures/ComputerScreen_emissive.png'],
  ['launch-videos/source-assets/models/laptop/textures/ComputerScreen_metallicRoughness.png', 'models/laptop/textures/ComputerScreen_metallicRoughness.png'],
  ['launch-videos/source-assets/models/mac-mini-m4/mac-mini-m4.glb', 'models/mac-mini-m4/mac-mini-m4.glb'],
  ['launch-videos/source-assets/models/mac-mini-m4/license.txt', 'models/mac-mini-m4/license.txt'],
  ['launch-videos/source-assets/models/server-console/scene.gltf', 'models/server-console/scene.gltf'],
  ['launch-videos/source-assets/models/server-console/scene.bin', 'models/server-console/scene.bin'],
  ['launch-videos/source-assets/models/server-console/license.txt', 'models/server-console/license.txt'],
  ['launch-videos/source-assets/models/server-console/textures/Cube12_auv_baseColor.png', 'models/server-console/textures/Cube12_auv_baseColor.png'],
  ['launch-videos/source-assets/models/server-console/textures/Cube1_auv_baseColor.png', 'models/server-console/textures/Cube1_auv_baseColor.png'],
  ['launch-videos/source-assets/models/server-console/textures/console_auv_baseColor.png', 'models/server-console/textures/console_auv_baseColor.png'],
  ['launch-videos/source-assets/models/raspberry-pi-3/scene.gltf', 'models/raspberry-pi-3/scene.gltf'],
  ['launch-videos/source-assets/models/raspberry-pi-3/scene.bin', 'models/raspberry-pi-3/scene.bin'],
  ['launch-videos/source-assets/models/raspberry-pi-3/license.txt', 'models/raspberry-pi-3/license.txt'],
  ['launch-videos/source-assets/models/raspberry-pi-3/textures/Material_baseColor.jpeg', 'models/raspberry-pi-3/textures/Material_baseColor.jpeg'],
];

for (const target of targets) {
  for (const [source, destination] of files) {
    const input = resolve(repo, source);
    if (source.startsWith('assets/screenshots/')) {
      try {
        await access(input);
      } catch {
        continue;
      }
    }
    const output = resolve(target, destination);
    await mkdir(dirname(output), {recursive: true});
    await copyFile(input, output);
  }
}

console.log('Prepared current Whip and Herdr launch-video assets.');
