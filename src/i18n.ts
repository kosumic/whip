import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { en } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { ja } from './locales/ja';
import { zhHans } from './locales/zh-Hans';
import { zhHant } from './locales/zh-Hant';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './services/operationalDiagnostics';

type LocalePreference = Pick<ReturnType<typeof getLocales>[number], 'languageCode' | 'languageScriptCode' | 'regionCode'>;
export type SupportedLanguage = 'en' | 'zh-Hant' | 'zh-Hans' | 'ja' | 'es' | 'fr';

export function languageForLocale(locale: LocalePreference | undefined): SupportedLanguage {
  if (!locale) return 'en';
  if (locale.languageCode === 'ja') return 'ja';
  if (locale.languageCode === 'es') return 'es';
  if (locale.languageCode === 'fr') return 'fr';
  const traditionalRegion = locale.regionCode === 'TW' || locale.regionCode === 'HK' || locale.regionCode === 'MO';
  if (locale.languageCode === 'zh') {
    return locale.languageScriptCode === 'Hant' || traditionalRegion ? 'zh-Hant' : 'zh-Hans';
  }
  return 'en';
}

export function deviceLanguage(): SupportedLanguage {
  return languageForLocale(getLocales()[0]);
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
    fr: { translation: fr },
    ja: { translation: ja },
    'zh-Hans': { translation: zhHans },
    'zh-Hant': { translation: zhHant },
  },
  lng: deviceLanguage(),
  fallbackLng: 'en',
  supportedLngs: ['en', 'zh-Hant', 'zh-Hans', 'ja', 'es', 'fr'],
  keySeparator: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
}).catch(error => {
  recordOperationalDiagnostic('error', 'Application', 'localization-initialization-failed', {
    ...operationalErrorDetails(error),
  });
});

export default i18n;
