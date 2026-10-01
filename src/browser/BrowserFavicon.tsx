import { useEffect, useState } from 'react';
import { Image } from 'react-native';
import { Globe } from 'lucide-react-native';
import { browserFavicon } from './native';
import { isSshTunnelHost } from '../lib/terminalLinks';
import { useTheme } from '../theme';

const ICON_SIZE = 28;
const icons = new Map<string, string>();

export function BrowserFavicon({
  url,
  runtimeId,
}: {
  url: string;
  runtimeId: string;
}) {
  const { colors } = useTheme();
  const [source, setSource] = useState<string>();
  useEffect(() => {
    let mounted = true;
    setSource(undefined);
    const host = new URL(url).hostname;
    // Private host names stay inside their SSH connection.
    if (isSshTunnelHost(host) || !host.includes('.') || host.endsWith('.local'))
      return;
    const saved = icons.get(host);
    if (saved) {
      setSource(saved);
      return;
    }
    const address = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
    void browserFavicon(runtimeId, address).then(
      uri => {
        if (icons.size >= 100) icons.delete(icons.keys().next().value!);
        icons.set(host, uri);
        if (mounted) setSource(uri);
      },
      () => undefined,
    );
    return () => {
      mounted = false;
    };
  }, [url, runtimeId]);
  return source ? (
    <Image
      source={{ uri: source }}
      style={{ width: ICON_SIZE, height: ICON_SIZE }}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
      onError={() => {
        icons.delete(new URL(url).hostname);
        setSource(undefined);
      }}
    />
  ) : (
    <Globe size={ICON_SIZE} color={colors.text} />
  );
}
