import { LocalSvg } from 'react-native-svg/css';
import type { BrowserSearchEngine } from './search';
import { bundledAsset } from '../lib/bundledAsset';

const ENGINE_ICONS: Record<BrowserSearchEngine, number> = {
  google: bundledAsset(
    require('../../assets/browser/search-engines/google.svg'),
  ),
  duckduckgo: bundledAsset(
    require('../../assets/browser/search-engines/duckduckgo.svg'),
  ),
  bing: bundledAsset(require('../../assets/browser/search-engines/bing.svg')),
  brave: bundledAsset(require('../../assets/browser/search-engines/brave.svg')),
};

export function SearchEngineIcon({ engine }: { engine: BrowserSearchEngine }) {
  return (
    <LocalSvg
      accessible={false}
      importantForAccessibility="no"
      asset={ENGINE_ICONS[engine]}
      width={22}
      height={22}
    />
  );
}
