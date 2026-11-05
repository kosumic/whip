import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LiveVoiceHistory } from '../src/components/LiveVoiceHistory';
import { GlassButton } from '../src/components/GlassControls';
import { appStorage } from '../src/services/appStorage';

jest.mock('../src/services/appStorage', () => ({ appStorage: { getItem: jest.fn() } }));
jest.mock('../src/components/GlassControls', () => ({ GlassButton: 'GlassButton' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let renderer: ReactTestRenderer;
afterEach(async () => { await act(async () => renderer?.unmount()); });

test('saved call captions load only on request and remain separate by speaker', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(JSON.stringify([{ id: 'call', endedAtMs: 1000, fragments: [
    { id: 'user', role: 'user', text: 'Check the build', startMs: 0, endMs: 100 },
    { id: 'assistant', role: 'assistant', text: 'The build passed', startMs: 150, endMs: 200 },
  ] }]));
  await act(async () => { renderer = create(<LiveVoiceHistory />); });
  expect(appStorage.getItem).not.toHaveBeenCalled();
  await act(async () => renderer.root.findByType(GlassButton).props.onPress());
  expect(appStorage.getItem).toHaveBeenCalledWith('whip.voice.live.transcripts');
  await act(async () => renderer.root.findAllByType(GlassButton)[1].props.onPress());
  const visible = JSON.stringify(renderer.toJSON());
  expect(visible).toContain('Check the build');
  expect(visible).toContain('The build passed');
  expect(visible).toContain('voiceProvider.captionUser');
  expect(visible).toContain('voiceProvider.captionAssistant');
});

test('invalid saved data reports a storage error without rendering its contents', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(JSON.stringify([{ id: 'call', fragments: [{ role: 'reasoning', text: 'PRIVATE' }] }]));
  await act(async () => { renderer = create(<LiveVoiceHistory />); });
  await act(async () => renderer.root.findByType(GlassButton).props.onPress());
  expect(JSON.stringify(renderer.toJSON())).toContain('voiceUsage.storageError');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('PRIVATE');
});
