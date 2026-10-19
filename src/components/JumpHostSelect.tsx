import { ArrowRight, Check, ChevronDown, Network } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { APP_FROSTED_GLASS_SURFACE_PROPS } from '@/src/lib/appGlass';
import { hostDisplayName } from '@/src/lib/hostProfiles';
import { cn } from '@/src/lib/utils';
import { appGlassControlStyle, useTheme } from '@/src/theme';
import type { HostProfile } from '@/src/types';
import { hapticPress } from './app-ui';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export function JumpHostSelect({ hosts, selectedHostId, disabled, onSelect }: {
  hosts: HostProfile[];
  selectedHostId?: string;
  disabled?: boolean;
  onSelect: (hostId: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <JumpHostField
        jumpHost={hosts.find(host => host.id === selectedHostId)}
        disabled={disabled}
        onPress={() => setOpen(true)}
      />
      <JumpHostPicker
        hosts={hosts}
        selectedHostId={selectedHostId}
        visible={open}
        onClose={() => setOpen(false)}
        onSelect={hostId => {
          onSelect(hostId);
          setOpen(false);
        }}
      />
    </>
  );
}

function JumpHostField({ jumpHost, disabled, onPress }: { jumpHost?: HostProfile; disabled?: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  return (
    <View className="mb-3.5">
      <Text className="mb-1.5 text-xs font-medium text-muted-foreground">{t('connection.jumpHost')}</Text>
      <Button
        accessibilityLabel={t('connection.chooseJumpHost')}
        disabled={disabled}
        className={cn('h-[52px] justify-start rounded-md border border-border px-3.5', !appGlassEnabled && 'bg-card')}
        style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
        variant="ghost"
        onPress={hapticPress(onPress)}>
        <Icon as={Network} size={18} />
        <View className="min-w-0 flex-1">
          <Text className="text-[14px] font-medium" numberOfLines={1}>
            {jumpHost ? hostDisplayName(jumpHost) : t('connection.directConnection')}
          </Text>
          {jumpHost ? (
            <Text className="mt-0.5 text-[11px] text-muted-foreground" numberOfLines={1}>
              {jumpHost.username}@{jumpHost.host}:{jumpHost.port}
            </Text>
          ) : null}
        </View>
        <Icon as={ChevronDown} className="text-muted-foreground" size={17} />
      </Button>
    </View>
  );
}

function JumpHostPicker({ hosts, selectedHostId, visible, onClose, onSelect }: {
  hosts: HostProfile[];
  selectedHostId?: string;
  visible: boolean;
  onClose: () => void;
  onSelect: (hostId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const options: Array<HostProfile | null> = [null, ...hosts];
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/55">
        <Pressable accessibilityLabel={t('connection.closeJumpHostPicker')} className="absolute inset-0" onPress={onClose} />
        <GlassSurface {...APP_FROSTED_GLASS_SURFACE_PROPS} className="max-h-[72%] rounded-t-[28px] border-t border-border px-4 pb-8 pt-5" fallbackClassName="bg-card">
          <Text className="px-2 text-lg font-semibold">{t('connection.chooseJumpHost')}</Text>
          <Text className="mb-3 mt-1 px-2 text-[13px] leading-[18px] text-muted-foreground">{t('connection.jumpHostCopy')}</Text>
          <ScrollView>
            {options.map(host => {
              const selected = host ? host.id === selectedHostId : !selectedHostId;
              return (
                <Button
                  key={host?.id || 'direct'}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  className="min-h-[62px] justify-start rounded-xl px-3 py-2"
                  size="content"
                  variant="ghost"
                  onPress={hapticPress(() => onSelect(host?.id))}>
                  <Icon as={host ? Network : ArrowRight} size={19} />
                  <View className="ml-1 min-w-0 flex-1">
                    <Text className="text-[15px] font-medium" numberOfLines={1}>
                      {host ? hostDisplayName(host) : t('connection.directConnection')}
                    </Text>
                    <Text className="mt-0.5 text-[11px] text-muted-foreground" numberOfLines={1}>
                      {host ? `${host.username}@${host.host}:${host.port}` : t('connection.directConnectionCopy')}
                    </Text>
                  </View>
                  {selected ? <Icon as={Check} className="text-primary" size={18} /> : null}
                </Button>
              );
            })}
          </ScrollView>
          <Button className="mt-2 rounded-full" variant="secondary" onPress={hapticPress(onClose)}><Text>{t('common.cancel')}</Text></Button>
        </GlassSurface>
      </View>
    </Modal>
  );
}
