import { LocalSvg } from 'react-native-svg/css';

import { bundledAsset } from '@/src/lib/bundledAsset';
import { useTheme } from '@/src/theme';

const AGENT_ICONS = new Map<string, { light: number; dark?: number }>([
  ['codex', { light: bundledAsset(require('../../assets/agents/codex.svg')) }],
  ['opencode', {
    light: bundledAsset(require('../../assets/agents/opencode-light.svg')),
    dark: bundledAsset(require('../../assets/agents/opencode-dark.svg')),
  }],
  ['pi', { light: bundledAsset(require('../../assets/agents/pi.svg')) }],
]);

export function AgentTypeIcon({ agent }: { agent: string }) {
  const { colors, isDark } = useTheme();
  const icon = AGENT_ICONS.get(agent.trim().toLowerCase());
  if (!icon) return null;

  return (
    <LocalSvg
      accessible={false}
      importantForAccessibility="no"
      asset={isDark ? icon.dark ?? icon.light : icon.light}
      color={colors.textTertiary}
      width={14}
      height={14}
      style={{ flexShrink: 0 }}
    />
  );
}
