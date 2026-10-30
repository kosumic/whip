import { expect, open, test } from 'nsh/test';
import { WhipAbout } from 'whip/about';
import { en } from '../../../src/locales/en';
import { ja } from '../../../src/locales/ja';
import { fr } from '../../../src/locales/fr';
import { es } from '../../../src/locales/es';
import { zhHans } from '../../../src/locales/zh-Hans';
import { zhHant } from '../../../src/locales/zh-Hant';
import { WHIP_INSTALL_URL, WHIP_REPOSITORY_URL, X_PROFILE_URL, GOVUE_REPOSITORY_URL, LATEST_RELEASE_API_URL } from '../../../src/lib/aboutLinks';
import { HERDR_WEBSITE_URL } from '../../../src/lib/herdr';

const environment = {
  locale: 'en', version: '1.9.9', commit: 'abcdef0123456789', channel: 'github', platform: 'ios', fontScale: 1,
  isDark: false, glassEnabled: false, liquidGlassAvailable: false,
  colors: { text: '#24292F', textSecondary: '#57606A', surface: '#F6F8FA', surfaceRaised: '#EAEEF2',
    canvas: '#FFFFFF', divider: '#D0D7DE', primary: '#0969DA', onPrimary: '#FFFFFF' },
};
const host = {
  params: environment,
  handlers: { height: null, licenses: null, openURL: null, share: null, alert: null },
};

test('expands in the parent flow, shows core protocols and collapses', async () => {
  const app = await open('./App.tsx', { host, height: 4096 });
  expect(app.shows(en['about.source'])).toBe(false);
  await app.press(en['about.expand']);
  await app.waitFor(en['about.source']);
  expect(app.shows('JetBrains Mono')).toBe(true);
  expect(app.shows(en['about.supportedHerdr'])).toBe(true);
  expect(app.shows(en['common.protocol'].replace('{{version}}', WhipAbout.protocolLabel()))).toBe(true);
  const expanded = app.host.posts().filter(post => post.name === 'height').at(-1)!;
  expect((expanded.data as { height: number }).height > 500).toBe(true);
  await app.press(en['about.collapse']);
  await app.waitUntil(() => !app.shows(en['about.source']));
  const collapsed = app.host.posts().filter(post => post.name === 'height').at(-1)!;
  expect((collapsed.data as { height: number }).height < 150).toBe(true);
});

test('opens the existing links, shares messages and delegates only licenses to RN navigation', async () => {
  const app = await open('./App.tsx', { host, height: 4096 });
  await app.press(en['about.expand']);
  await app.waitFor(en['about.source']);
  for (const [label, url] of [
    [en['about.githubRepository'], WHIP_REPOSITORY_URL], ['X', X_PROFILE_URL],
    [en['about.herdrWebsite'], HERDR_WEBSITE_URL], [en['about.openInstallLink'], WHIP_INSTALL_URL], ['GoVue', GOVUE_REPOSITORY_URL],
  ]) {
    await app.press(label);
    expect(app.host.calls().some(call => call.name === 'openURL' && (call.data as { url: string }).url === url)).toBe(true);
  }
  for (const label of [en['about.shareRepository'], en['about.shareHerdrWebsite'], en['about.shareApp']]) await app.press(label);
  expect(app.host.calls().filter(call => call.name === 'share').length).toBe(3);
  await app.press(en['about.openLicenses']);
  expect(app.host.posts().some(post => post.name === 'licenses')).toBe(true);
});

test('keeps the original text hierarchy and inline commit link', async () => {
  const app = await open('./App.tsx', { host, height: 4096 });
  await app.press(en['about.expand']);
  await app.waitFor(en['about.source']);
  expect(app.spanStyle(`text:${en['about.title']}`)).toMatchObject({ fontSize: 17, fontWeight: 600 });
  expect(app.spanStyle(`text:${en['about.tagline']}`)).toMatchObject({ fontSize: 14, fontWeight: 400 });
  const commit = en['about.commit'].replace('{{hash}}', environment.commit.slice(0, 12));
  expect(app.spanStyle(`text:${commit}`)).toMatchObject({ fontSize: 12, color: '#0969daff', underline: true });
  await app.host.send('environment', { ...environment, isDark: true, glassEnabled: true,
    colors: { ...environment.colors, primary: '#7AA2F7' } });
  await app.waitUntil(() => app.spanStyle(`text:${commit}`).color === '#7aa2f7ff');
  expect(app.shows(en['about.collapse'])).toBe(true);
});

test('responds to live locale and theme changes without remounting', async () => {
  const app = await open('./App.tsx', { host, height: 4096 });
  await app.press(en['about.expand']);
  await app.waitFor(en['about.source']);
  for (const [locale, catalog] of [['ja', ja], ['fr', fr], ['es', es], ['zh-Hans', zhHans], ['zh-Hant', zhHant]] as const) {
    await app.host.send('environment', { ...environment, locale, fontScale: 1.5, isDark: true, glassEnabled: true,
      colors: { ...environment.colors, text: '#C0CAF5', surface: '#24283B' } });
    await app.waitFor(catalog['about.source']);
    expect(app.shows(catalog['about.supportedHerdr'])).toBe(true);
    expect(app.spanStyle(`text:${catalog['about.supportedHerdr']}`).color).toBe('#c0caf5ff');
  }
});

test('preserves GitHub-only updates, errors and the direct Rust version evaluation', async () => {
  const app = await open('./App.tsx', { host, height: 4096, network: {
    [LATEST_RELEASE_API_URL]: { body: JSON.stringify({ tag_name: 'v1.10.0', draft: false, prerelease: false }) },
  } });
  await app.press(en['about.expand']);
  await app.waitFor(en['about.source']);
  await app.press(en['about.checkUpdates']);
  await app.waitFor(en['about.updateAvailable'].replace('{{version}}', '1.10.0'));
  await app.host.send('environment', { ...environment, channel: 'app-store' });
  await app.waitUntil(() => !app.shows(en['about.checkUpdates']));
  const offline = await open('./App.tsx', { host, height: 4096 });
  await offline.press(en['about.expand']);
  await offline.waitFor(en['about.source']);
  await offline.press(en['about.checkUpdates']);
  await offline.waitFor(en['about.updateCheckError']);
});

test('reports a failed platform action using the current translation', async () => {
  const app = await open('./App.tsx', { height: 4096, host: { ...host,
    params: { ...environment, platform: 'android' }, handlers: {
    ...host.handlers, openURL: () => { throw new Error('No browser'); },
  } } });
  await app.press(en['about.expand']);
  await app.waitFor(en['about.source']);
  await app.press(en['about.githubRepository']);
  await app.waitUntil(() => app.host.calls().some(call => call.name === 'alert'));
  const alert = app.host.calls().find(call => call.name === 'alert')!;
  expect((alert.data as { title: string }).title).toBe(en['about.githubError']);
});
