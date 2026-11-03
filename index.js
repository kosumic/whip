import './src/logBoxWarnings';
import { registerRootComponent } from 'expo';
import { AppRegistry } from 'react-native';
import { runVoiceCallBackground, VOICE_CALL_BACKGROUND_TASK } from './src/services/voiceCallBackground';
import './src/i18n';
import App from './App';

AppRegistry.registerHeadlessTask(VOICE_CALL_BACKGROUND_TASK, () => runVoiceCallBackground);
registerRootComponent(App);
