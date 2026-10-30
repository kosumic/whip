import { LocalSvg } from 'react-native-svg/css';
import { bundledAsset } from '../lib/bundledAsset';
import { useTheme } from '../theme';

const GITHUB_ASSET = bundledAsset(require('../../assets/brand/github.svg'));

export function GitHubMark({ size }: { size: number }) {
  const { colors } = useTheme();
  return <LocalSvg accessible={false} asset={GITHUB_ASSET} color={colors.text} width={size} height={size} />;
}
