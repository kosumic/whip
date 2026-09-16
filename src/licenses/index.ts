import { GENERATED_OPEN_SOURCE_LICENSES } from './generated';
import { bundledAsset } from '../lib/bundledAsset';

export interface OpenSourceLicenseNotice {
  id: string;
  category?: 'npm' | 'cargo';
  projectName: string;
  sourceUrl: string;
  attribution: string;
  attributionKey?: string;
  licenseName: string;
  copyright?: string;
  licenseAsset: number;
}

export const OPEN_SOURCE_LICENSES: readonly OpenSourceLicenseNotice[] = [
  {
    id: 'whip',
    projectName: 'Whip',
    sourceUrl: 'https://github.com/kosumic/whip',
    attribution: 'Whip is free software licensed under the GNU Affero General Public License.',
    licenseName: 'AGPL-3.0-or-later',
    licenseAsset: bundledAsset(require('../../assets/licenses/whip-AGPL-3.0.txt')),
  },
  {
    id: 'opencode-web',
    projectName: 'OpenCode Web',
    sourceUrl: 'https://github.com/anomalyco/opencode',
    attribution: "Whip's Chat View is inspired by and adapted from OpenCode Web's conversation design.",
    attributionKey: 'licenses.opencodeAttribution',
    licenseName: 'MIT License',
    copyright: 'Copyright (c) 2025 opencode',
    licenseAsset: bundledAsset(require('../../assets/licenses/opencode-MIT.txt')),
  },
  {
    id: 'inter',
    projectName: 'Inter',
    sourceUrl: 'https://github.com/rsms/inter',
    attribution: "Whip's interface uses the bundled Inter font family.",
    licenseName: 'SIL Open Font License 1.1',
    copyright: 'Copyright (c) 2016 The Inter Project Authors',
    licenseAsset: bundledAsset(require('../../assets/licenses/inter-OFL-1.1.txt')),
  },
  {
    id: 'jetbrains-mono',
    projectName: 'JetBrains Mono',
    sourceUrl: 'https://github.com/JetBrains/JetBrainsMono',
    attribution: "Whip's terminal uses the bundled JetBrains Mono font family.",
    licenseName: 'SIL Open Font License 1.1',
    copyright: 'Copyright 2020 The JetBrains Mono Project Authors',
    licenseAsset: bundledAsset(require('../../assets/licenses/jetbrains-mono-OFL-1.1.txt')),
  },
  {
    id: 'ar-pl-ukai-hk',
    projectName: 'AR PL UKai HK',
    sourceUrl: 'https://www.freedesktop.org/wiki/Software/CJKUnifonts/',
    attribution: "Whip's terminal bundles AR PL UKai HK for CJK text coverage.",
    licenseName: 'Arphic Public License',
    copyright: 'Copyright (C) 1999 Arphic Technology Co., Ltd.',
    licenseAsset: bundledAsset(require('../../assets/licenses/arphic-public-license.txt')),
  },
  {
    id: 'symbols-nerd-font-mono',
    projectName: 'Symbols Nerd Font Mono',
    sourceUrl: 'https://github.com/ryanoasis/nerd-fonts',
    attribution: "Whip's terminal bundles Nerd Fonts symbols for terminal glyph coverage.",
    licenseName: 'MIT License',
    copyright: 'Copyright (c) 2014 Ryan L McIntyre',
    licenseAsset: bundledAsset(require('../../assets/licenses/nerd-fonts-MIT.txt')),
  },
  {
    id: 'mermaid',
    projectName: 'Mermaid',
    sourceUrl: 'https://github.com/mermaid-js/mermaid',
    attribution: 'Whip uses Mermaid to render diagrams in remote file previews.',
    licenseName: 'MIT License',
    copyright: 'Copyright (c) 2014 - 2022 Knut Sveidqvist',
    licenseAsset: bundledAsset(require('../../assets/licenses/mermaid-MIT.txt')),
  },
  {
    id: 'xterm-js',
    projectName: 'xterm.js',
    sourceUrl: 'https://github.com/xtermjs/xterm.js',
    attribution: "Whip's terminal renderer uses xterm.js and its addons.",
    licenseName: 'MIT License',
    copyright: 'Copyright (c) 2017-2019, The xterm.js authors\nCopyright (c) 2014-2016, SourceLair Private Company\nCopyright (c) 2012-2013, Christopher Jeffrey',
    licenseAsset: bundledAsset(require('../../assets/licenses/xterm-MIT.txt')),
  },
  {
    id: 'lucide',
    projectName: 'Lucide Icons',
    sourceUrl: 'https://github.com/lucide-icons/lucide',
    attribution: 'Whip uses Lucide icons, including icons derived from the Feather project.',
    licenseName: 'ISC License and MIT License',
    copyright: 'Copyright (c) 2026 Lucide Icons and Contributors\nCopyright (c) 2013-present Cole Bemis',
    licenseAsset: bundledAsset(require('../../assets/licenses/lucide-ISC-and-Feather-MIT.txt')),
  },
  ...GENERATED_OPEN_SOURCE_LICENSES,
];
