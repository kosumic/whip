import { useEffect, useState } from 'react';
import { Asset } from 'expo-asset';
import { Platform } from 'react-native';
import { Skia, type SkTypefaceFontProvider } from '@shopify/react-native-skia';
import manifest from '../../assets/terminal-fonts/manifest.json';
import { terminalFontFamily } from './terminalFonts';
import { bundledAsset } from './bundledAsset';

const sources: readonly (readonly [string, number])[] = [
  [
    terminalFontFamily,
    bundledAsset(
      require('../../assets/terminal-fonts/JetBrainsMono-Regular.ttf'),
    ),
  ],
  [
    terminalFontFamily,
    bundledAsset(require('../../assets/terminal-fonts/JetBrainsMono-Bold.ttf')),
  ],
  [
    manifest.symbols.cssFamily,
    bundledAsset(
      require('../../assets/terminal-fonts/SymbolsNerdFontMono-Regular.ttf'),
    ),
  ],
  [
    manifest.unicodeSymbols.cssFamily,
    bundledAsset(
      require('../../assets/terminal-fonts/NotoSansSymbols2-Regular.ttf'),
    ),
  ],
  [
    manifest.cjk.cssFamily,
    bundledAsset(require('../../assets/terminal-fonts/ArphicUKaiHK.ttf')),
  ],
];

export const skiaTerminalFontFamilies = [
  terminalFontFamily,
  Platform.OS === 'ios' ? 'Apple Color Emoji' : manifest.emoji.cssFamily,
  manifest.symbols.cssFamily,
  manifest.unicodeSymbols.cssFamily,
  manifest.cjk.cssFamily,
  Platform.OS === 'ios' ? 'Menlo' : 'monospace',
];

let cachedFonts: Promise<SkTypefaceFontProvider> | undefined;
function loadFonts(): Promise<SkTypefaceFontProvider> {
  cachedFonts ??= Promise.all(
    sources.map(async ([family, module]) => {
      const asset = Asset.fromModule(module);
      await asset.downloadAsync();
      const data = await Skia.Data.fromURI(asset.localUri ?? asset.uri);
      const face = Skia.Typeface.MakeFreeTypeFaceFromData(data);
      if (!face) throw new Error(`Cannot load terminal font: ${family}`);
      return [family, face] as const;
    }),
  ).then(faces => {
    const provider = Skia.TypefaceFontProvider.Make();
    for (const [family, face] of faces) provider.registerFont(face, family);
    return provider;
  });
  return cachedFonts;
}

export function useSkiaTerminalFonts() {
  const [fonts, setFonts] = useState<SkTypefaceFontProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadFonts().then(
      provider => {
        if (active) setFonts(provider);
      },
      reason => {
        if (active) setError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return { fonts, error };
}
