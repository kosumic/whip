import { useState } from 'react';
import { View } from 'react-native';
import { LocalSvg } from 'react-native-svg/css';
import { Check, ChevronDown, ChevronUp } from 'lucide-react-native';
import { BROWSER_SEARCH_ENGINES, type BrowserSearchEngine } from './search';
import { Button } from '../components/ui/button';
import { Icon } from '../components/ui/icon';
import { Text } from '../components/ui/text';
import { bundledAsset } from '../lib/bundledAsset';
import { GlassSurface, useAppGlassEnabled } from '../components/GlassSurface';

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

function EngineIcon({ engine }: { engine: BrowserSearchEngine }) {
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

export function SearchEngineSelect({
  value,
  onChange,
}: {
  value: BrowserSearchEngine;
  onChange: (engine: BrowserSearchEngine) => void;
}) {
  const [open, setOpen] = useState(false);
  const glassEnabled = useAppGlassEnabled();
  const selected =
    BROWSER_SEARCH_ENGINES.find(engine => engine.id === value) ||
    BROWSER_SEARCH_ENGINES[0];
  return (
    <View className="gap-2">
      <GlassSurface className="rounded-md border border-white/30 dark:border-white/10">
        <Button
          accessibilityLabel="Choose search engine"
          accessibilityState={{ expanded: open }}
          className="h-12 justify-start bg-transparent px-3"
          variant="ghost"
          onPress={() => setOpen(previous => !previous)}
        >
          <EngineIcon engine={selected.id} />
          <Text className="flex-1 text-left text-sm font-medium">
            {selected.label}
          </Text>
          <Icon
            as={open ? ChevronUp : ChevronDown}
            className="text-muted-foreground"
            size={18}
          />
        </Button>
      </GlassSurface>
      {open && (
        <GlassSurface
          accessibilityRole="menu"
          className="rounded-lg border border-white/30 dark:border-white/10"
        >
          {BROWSER_SEARCH_ENGINES.map((engine, index) => (
            <Button
              key={engine.id}
              accessibilityLabel={`Search with ${engine.label}`}
              role="menuitem"
              accessibilityState={{ selected: value === engine.id }}
              className={`h-12 justify-start rounded-none px-3 ${index ? 'border-t border-border' : ''} ${glassEnabled && value === engine.id ? 'bg-primary/10 active:bg-primary/20' : ''}`}
              variant={
                !glassEnabled && value === engine.id ? 'secondary' : 'ghost'
              }
              onPress={() => {
                onChange(engine.id);
                setOpen(false);
              }}
            >
              <EngineIcon engine={engine.id} />
              <Text className="flex-1 text-left text-sm font-medium">
                {engine.label}
              </Text>
              {value === engine.id && (
                <Icon as={Check} className="text-primary" size={18} />
              )}
            </Button>
          ))}
        </GlassSurface>
      )}
    </View>
  );
}
