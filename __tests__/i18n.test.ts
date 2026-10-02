jest.mock('expo-localization', () => ({ getLocales: () => [] }));

import { en } from '../src/locales/en';
import { es } from '../src/locales/es';
import { fr } from '../src/locales/fr';
import { ja } from '../src/locales/ja';
import { zhHans } from '../src/locales/zh-Hans';
import { zhHant } from '../src/locales/zh-Hant';
import i18n, { languageForLocale } from '../src/i18n';

const translatedLocales = { es, fr, ja, 'zh-Hans': zhHans, 'zh-Hant': zhHant };

function placeholders(value: string): string[] {
  return value.match(/\{\{[^}]+\}\}|\{[^{}]+\}/g)?.sort() || [];
}

describe('localization resources', () => {
  it.each(Object.entries(translatedLocales))('keeps %s in sync with the English source catalog', (_language, resource) => {
    expect(Object.keys(resource).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(resource[key])).toEqual(placeholders(en[key]));
    }
  });

  it('includes translated primary navigation and settings labels', () => {
    expect(zhHant['nav.hosts']).toBe('主機');
    expect(zhHant['nav.terminal']).toBe('終端機');
    expect(zhHant['settings.keepScreenOn']).toBe('保持螢幕開啟');
    expect(zhHant['settings.language']).toBe('語言');
    expect(zhHant['connection.addPrivateKey']).toBe('新增私密金鑰');
    expect(zhHans['nav.terminal']).toBe('终端');
    expect(ja['settings.language']).toBe('言語');
    expect(es['settings.language']).toBe('Idioma');
    expect(fr['settings.language']).toBe('Langue');
  });

  it('maps supported device locales to their app language', () => {
    expect(languageForLocale({ languageCode: 'ja', languageScriptCode: null, regionCode: 'JP' })).toBe('ja');
    expect(languageForLocale({ languageCode: 'es', languageScriptCode: null, regionCode: 'MX' })).toBe('es');
    expect(languageForLocale({ languageCode: 'zh', languageScriptCode: 'Hans', regionCode: 'CN' })).toBe('zh-Hans');
    expect(languageForLocale({ languageCode: 'zh', languageScriptCode: null, regionCode: 'SG' })).toBe('zh-Hans');
    expect(languageForLocale({ languageCode: 'zh', languageScriptCode: 'Hant', regionCode: 'TW' })).toBe('zh-Hant');
    expect(languageForLocale({ languageCode: 'de', languageScriptCode: null, regionCode: 'DE' })).toBe('en');
    expect(languageForLocale(undefined)).toBe('en');
  });

  it.each(['FR', 'CA', 'BE', 'CH'])('uses French for the fr-%s device locale', regionCode => {
    expect(languageForLocale({ languageCode: 'fr', languageScriptCode: null, regionCode })).toBe('fr');
  });

  it('renders French translations, interpolation, and plurals through i18next', () => {
    const t = i18n.getFixedT('fr');
    expect(t('settings.title')).toBe('Paramètres');
    expect(t('hosts.connectTo', { host: 'dev.example' })).toBe('Se connecter à dev.example');
    expect(t('hosts.count', { count: 0 })).toBe('0 serveur sur cet appareil');
    expect(t('hosts.count', { count: 1 })).toBe('1 serveur sur cet appareil');
    expect(t('hosts.count', { count: 2 })).toBe('2 serveurs sur cet appareil');
  });

  it('describes hosts as general SSH destinations', () => {
    expect(en['about.tagline']).toBe('An Agent-native mobile SSH client, designed for Herdr');
    expect(en['hosts.emptyCopy']).toBe('Add an SSH destination to manage its Herdr session.');
    expect(en['connection.displayName']).toBe('Display name (optional)');
    expect(en['connection.hostOrIp']).toBe('SSH host or IP');
    expect(zhHant['connection.displayName']).toBe('顯示名稱（選填）');
    expect(en['app.connectUnreachableError']).not.toMatch(/tailscale/i);
    expect(zhHant['hosts.emptyCopy']).not.toMatch(/tailscale/i);
  });

  it('makes the command-free manual host path explicit', () => {
    expect(en['pairing.scan']).toBe('Scan pairing QR');
    expect(en['pairing.manual']).toBe('Enter host manually');
    expect(en['pairing.manualCopy']).toMatch(/^No commands needed on the host\./);
  });
});
