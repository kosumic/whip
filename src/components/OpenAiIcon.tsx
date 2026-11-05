import { LocalSvg } from 'react-native-svg/css';
import { bundledAsset } from '../lib/bundledAsset';
import { useTheme } from '../theme';

export function OpenAiIcon({ size = 20 }: { size?: number }) {
  const { colors } = useTheme();
  return <LocalSvg accessible={false} importantForAccessibility="no"
    asset={bundledAsset(require('../../assets/brand/openai.svg'))}
    color={colors.text} width={size} height={size} />;
}
