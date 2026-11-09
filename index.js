import './src/logBoxWarnings';
import { registerRootComponent } from 'expo';
import { AppRegistry } from 'react-native';
import { runVoiceCallBackground, VOICE_CALL_BACKGROUND_TASK } from './src/services/voiceCallBackground';
import './src/i18n';
import App from './App';
import { remoteDownloads, initializeRemoteDownloads } from './src/services/remoteDownloads';

AppRegistry.registerHeadlessTask(VOICE_CALL_BACKGROUND_TASK, () => runVoiceCallBackground);
AppRegistry.registerHeadlessTask('WhipSftpDownload', () => ({ id }) => remoteDownloads.wait(id));
initializeRemoteDownloads();
registerRootComponent(App);
