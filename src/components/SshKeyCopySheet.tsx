import { Copy, KeyRound, QrCode } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SvgXml } from 'react-native-svg';
import { LocalSvg } from 'react-native-svg/css';
import { inspectPublicKey, type PublicKeyShare } from 'react-native-whip-ssh';

import { cn } from '@/src/lib/utils';
import { APP_FROSTED_GLASS_SURFACE_PROPS } from '@/src/lib/appGlass';
import { bundledAsset } from '@/src/lib/bundledAsset';
import { whipQrImage, type WhipQrImage } from '@/src/lib/whipQr';
import { appGlassControlStyle, useTheme } from '@/src/theme';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { hapticPress } from './app-ui';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  visible: boolean;
  onClose: () => void;
  onCopyPrivate: () => void | Promise<void>;
  onCopyPublic: () => void | Promise<void>;
  onGetPublicKey: () => string;
}

export function SshKeyCopySheet({
  visible,
  onClose,
  onCopyPrivate,
  onCopyPublic,
  onGetPublicKey,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const [qr, setQr] = useState<{
    share: PublicKeyShare;
    image: WhipQrImage;
  } | null>(null);
  useEffect(() => {
    if (!visible) setQr(null);
  }, [visible]);

  const showPublicQr = () => {
    try {
      const share = inspectPublicKey(onGetPublicKey());
      setQr({ share, image: whipQrImage(share.qrPayload) });
    } catch (error) {
      Alert.alert(t('publicKeys.qrError'), String(error));
    }
  };

  return (
    <Modal
      animationType="fade"
      transparent
      visible={visible}
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel={t('connection.closeKeyActions')}
          className="absolute inset-0 bg-black/55"
          onPress={onClose}
        />
        <GlassSurface
          {...APP_FROSTED_GLASS_SURFACE_PROPS}
          accessibilityViewIsModal
          className="max-h-[88%] rounded-t-[28px] border-t border-white/30 px-4 pb-8 pt-5 dark:border-white/10"
        >
          <ScrollView>
            <Text className="px-2 text-lg font-semibold">
              {t(qr ? 'publicKeys.showQr' : 'connection.copySshKey')}
            </Text>
            {qr ? (
              <View className="items-center gap-4 px-2 py-5">
                <Text className="text-center text-sm leading-5 text-muted-foreground">
                  {t('publicKeys.shareCopy')}
                </Text>
                <View className="aspect-square w-full max-w-[360px] overflow-hidden rounded-3xl">
                  <SvgXml
                    accessibilityLabel={t('publicKeys.showQr')}
                    xml={qr.image.svg}
                    width="100%"
                    height="100%"
                  />
                  <View
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      left: `${(qr.image.logo.x / qr.image.size) * 100}%`,
                      top: `${(qr.image.logo.y / qr.image.size) * 100}%`,
                      width: `${(qr.image.logo.size / qr.image.size) * 100}%`,
                      height: `${(qr.image.logo.size / qr.image.size) * 100}%`,
                    }}
                  >
                    <LocalSvg
                      asset={bundledAsset(
                        require('../../assets/whip-cyborg-hand-concept.svg'),
                      )}
                      width="100%"
                      height="100%"
                    />
                  </View>
                </View>
                <Text
                  selectable
                  className="text-center font-mono text-xs leading-5"
                >
                  {qr.share.fingerprint}
                </Text>
                <Button
                  className="rounded-full"
                  variant="ghost"
                  onPress={() => setQr(null)}
                >
                  <Text>{t('connection.back')}</Text>
                </Button>
              </View>
            ) : (
              <>
                <Text className="mb-3 mt-1 px-2 text-[13px] leading-[18px] text-muted-foreground">
                  {t('connection.copyWhich')}
                </Text>
                <KeyCopyAction
                  icon={Copy}
                  label={t('connection.copyPrivate')}
                  onPress={onCopyPrivate}
                />
                <KeyCopyAction
                  icon={KeyRound}
                  label={t('connection.copyPublic')}
                  onPress={onCopyPublic}
                />
                <KeyCopyAction
                  icon={QrCode}
                  label={t('publicKeys.showQr')}
                  onPress={showPublicQr}
                />
              </>
            )}
          </ScrollView>
          <Button
            className={cn('mt-2 rounded-full', appGlassEnabled && 'border')}
            style={
              appGlassEnabled ? appGlassControlStyle(false, colors) : undefined
            }
            variant={appGlassEnabled ? 'ghost' : 'secondary'}
            onPress={hapticPress(onClose)}
          >
            <Text>{t('common.cancel')}</Text>
          </Button>
        </GlassSurface>
      </View>
    </Modal>
  );
}

function KeyCopyAction({
  icon,
  label,
  onPress,
}: {
  icon: typeof KeyRound;
  label: string;
  onPress: () => void | Promise<void>;
}) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  return (
    <Button
      className={cn(
        'h-14 justify-start rounded-xl px-3',
        appGlassEnabled && 'border',
      )}
      style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
      variant="ghost"
      onPress={() => {
        const operation = onPress();
        if (operation) reportBackgroundFailure(operation, 'ssh-key-copy');
      }}
    >
      <Icon as={icon} size={19} />
      <Text className="text-[15px] font-medium">{label}</Text>
    </Button>
  );
}
