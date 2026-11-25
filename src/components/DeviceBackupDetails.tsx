import Check from 'lucide-react-native/icons/check';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import CloudUpload from 'lucide-react-native/icons/cloud-upload';
import X from 'lucide-react-native/icons/x';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import { hapticPress } from '../services/interactionFeedback';
import { GlassIconBadge } from './GlassControls';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

// Each row describes eligibility when device backup is enabled.
const coverage = [
  ['hosts', 'included', 'included'],
  ['terminal', 'included', 'included'],
  ['browser', 'included', 'included'],
  ['usage', 'included', 'included'],
  ['backgrounds', 'included', 'included'],
  ['downloads', 'records', 'filesAndRecords'],
  ['hostCredentials', 'encrypted', 'deviceOnly'],
  ['globalKeys', 'metadata', 'metadata'],
  ['chatCache', 'excluded', 'excluded'],
] as const;

const dataColumn = 'min-w-0 flex-[1.7] pr-2';
const platformColumn = 'min-w-0 flex-1 px-1';
const headingText = 'text-xs font-semibold leading-4 text-muted-foreground';
const cellText = 'text-[13px] leading-[18px]';

type CoverageStatus = (typeof coverage)[number][1 | 2];

function CoverageCell({ status, label }: { status: CoverageStatus; label: string }) {
  if (status === 'included' || status === 'excluded') {
    const included = status === 'included';
    return (
      <View className={`${platformColumn} items-center`}>
        <Icon as={included ? Check : X} className={included ? 'text-success' : 'text-destructive'} size={18} accessible={false} />
      </View>
    );
  }
  return <Text className={`${platformColumn} ${cellText} text-center`}>{label}</Text>;
}

export function DeviceBackupDetails({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const title = t('settings.deviceBackup');
  const contents = t('backup.contents');
  const isAndroid = Platform.OS === 'android';
  const platformName = t(isAndroid ? 'backup.android' : 'backup.ios');

  return (
    <View className="border-t border-border">
      <View className="min-h-16 flex-row items-center gap-5 px-3.5 py-2">
        <GlassIconBadge className="bg-primary/10">
          <Icon as={CloudUpload} className="text-primary" size={18} />
        </GlassIconBadge>
        <Pressable
          accessibilityLabel={contents}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          className="min-h-11 min-w-0 flex-1 justify-center active:opacity-70"
          onPress={hapticPress(() => setExpanded(open => !open))}>
          <Text className="text-[15px] font-semibold leading-5">{title}</Text>
          <View className="mt-0.5 flex-row items-center gap-1">
            <Text className="shrink text-xs font-medium leading-4 text-primary">{contents}</Text>
            <Icon as={expanded ? ChevronUp : ChevronDown} className="text-primary" size={14} />
          </View>
        </Pressable>
        {children}
      </View>
      {expanded && (
        <View className="gap-3 px-3.5 pb-4">
          <Text className="text-xs leading-[17px] text-muted-foreground">{t('settings.deviceBackupCopy')}</Text>
          <View className="overflow-hidden rounded-lg border border-border">
            <View className="flex-row items-center bg-muted px-2.5 py-2">
              <Text className={`${dataColumn} ${headingText}`}>{t('backup.data')}</Text>
              <Text className={`${platformColumn} ${headingText} text-center`}>{platformName}</Text>
            </View>
            {coverage.map(([data, androidStatus, iosStatus]) => {
              const label = t(`backup.${data}`);
              const status = isAndroid ? androidStatus : iosStatus;
              const value = t(`backup.${status}`);
              return (
                <View
                  key={data}
                  accessible
                  accessibilityLabel={`${label}, ${platformName} ${value}`}
                  className="flex-row items-center border-t border-border px-2.5 py-2">
                  <Text className={`${dataColumn} ${cellText} font-medium`}>{label}</Text>
                  <CoverageCell status={status} label={value} />
                </View>
              );
            })}
          </View>
          {isAndroid && (
            <Text className="text-xs leading-[17px] text-muted-foreground">{t('backup.credentialRecovery')}</Text>
          )}
        </View>
      )}
    </View>
  );
}
