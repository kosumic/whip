import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewInstance } from 'react-native';
import { Info } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

const SettingsDetailsContext = createContext<{ showDetails: (copy: string, y: number) => void }>({
  showDetails: (_copy: string, _y: number) => undefined,
});

export function SettingsDetailsProvider({ children }: { children: ReactNode }) {
  const [tooltipHeight, setTooltipHeight] = useState(0);
  const [activeDetails, setActiveDetails] = useState<{
    copy: string;
    anchorY: number;
    containerHeight: number;
  } | null>(null);
  const containerRef = useRef<ViewInstance>(null);
  const showDetails = (copy: string, y: number) => {
    containerRef.current?.measureInWindow((_x, containerY, _width, containerHeight) => {
      setActiveDetails({
        copy,
        anchorY: y - containerY,
        containerHeight,
      });
    });
  };
  const tooltipPosition = {
    top: activeDetails
      ? Math.max(12, Math.min(
        activeDetails.anchorY >= tooltipHeight + 20
          ? activeDetails.anchorY - tooltipHeight - 8
          : activeDetails.anchorY + 40,
        activeDetails.containerHeight - tooltipHeight - 12,
      ))
      : 12,
  };
  return (
    <SettingsDetailsContext.Provider value={{ showDetails }}>
      <View ref={containerRef} className="flex-1" onTouchStart={() => setActiveDetails(null)}>
        {children}
        {activeDetails ? (
          <View pointerEvents="none" className="absolute inset-0">
            <View
              onLayout={event => setTooltipHeight(event.nativeEvent.layout.height)}
              className="absolute left-5 right-5 rounded-xl border border-border bg-foreground/70 px-4 py-3"
              style={[styles.detailsTooltip, tooltipPosition]}>
              <Text accessibilityLiveRegion="polite" className="text-sm leading-5 text-background">
                {activeDetails.copy}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </SettingsDetailsContext.Provider>
  );
}

export function DetailsTitle({ title, copy, titleClassName = 'text-[15px] font-semibold leading-5', onDetailsPress }: { title: string; copy: string; titleClassName?: string; onDetailsPress?: () => void }) {
  return (
    <View className="min-w-0">
      <View className="min-h-11 flex-row items-center">
        <Text className={`min-w-0 flex-shrink ${titleClassName}`}>{title}</Text>
        <DetailsInfoButton title={title} copy={copy} onDetailsPress={onDetailsPress} />
      </View>
    </View>
  );
}

export function DetailsInfoButton({ title, copy, onDetailsPress }: { title: string; copy: string; onDetailsPress?: () => void }) {
  const { showDetails } = useContext(SettingsDetailsContext);
  const buttonRef = useRef<ViewInstance>(null);
  const { t } = useTranslation();
  return (
    <Pressable
      ref={buttonRef}
      accessibilityHint={copy}
      accessibilityLabel={t('settings.details', { name: title })}
      accessibilityRole="button"
      className="ml-1 size-8 items-center justify-center rounded-full active:bg-muted"
      hitSlop={8}
      onPress={event => {
        event.stopPropagation();
        if (onDetailsPress) {
          onDetailsPress();
          return;
        }
        buttonRef.current?.measureInWindow((_x, y) => {
          showDetails(copy, y);
        });
      }}>
      <Icon as={Info} className="text-muted-foreground" size={16} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  detailsTooltip: {
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.24,
    shadowRadius: 12,
  },
});
