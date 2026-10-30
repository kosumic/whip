import { createInstance } from 'i18next';
import { en } from '../../../src/locales/en';
import { es } from '../../../src/locales/es';
import { fr } from '../../../src/locales/fr';
import { ja } from '../../../src/locales/ja';
import { zhHans } from '../../../src/locales/zh-Hans';
import { zhHant } from '../../../src/locales/zh-Hant';

export interface Environment {
  locale: string;
  fontScale: number;
  version: string;
  commit: string | null;
  channel: string | null;
  platform: string;
  isDark: boolean;
  glassEnabled: boolean;
  liquidGlassAvailable: boolean;
  colors: { text: string; textSecondary: string; surface: string; surfaceRaised: string;
    canvas: string; divider: string; primary: string; onPrimary: string };
}

/** Same catalogs and interpolation engine as RN; no React plugin or RN import. */
export function translations() {
  const i18n = createInstance();
  void i18n.init({
    resources: {
      en: { translation: en }, es: { translation: es }, fr: { translation: fr },
      ja: { translation: ja }, 'zh-Hans': { translation: zhHans }, 'zh-Hant': { translation: zhHant },
    },
    lng: 'en', fallbackLng: 'en', keySeparator: false,
    initAsync: false, interpolation: { escapeValue: false },
  });
  return (locale: string, key: string, values: Record<string, string> = {}) =>
    i18n.t(key, { ...values, lng: locale });
}
