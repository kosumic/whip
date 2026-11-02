import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import ExternalLink from 'lucide-react-native/icons/external-link';
import Scale from 'lucide-react-native/icons/scale';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Fragment, useState } from 'react';
import { Alert, Linking, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  OPEN_SOURCE_LICENSES,
  type OpenSourceLicenseNotice,
} from '@/src/licenses';
import { hapticPress, IconButton, ScreenHeader } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  onClose: () => void;
}

export function LicensesScreen({ onClose }: Props) {
  const [expandedLicenseIds, setExpandedLicenseIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [licenseTexts, setLicenseTexts] = useState<
    Readonly<Record<string, string>>
  >({});
  const [loadingLicenseIds, setLoadingLicenseIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [licenseErrors, setLicenseErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const { t } = useTranslation();

  const toggleLicense = (notice: OpenSourceLicenseNotice) => {
    const expanding = !expandedLicenseIds.has(notice.id);
    setExpandedLicenseIds(current => {
      const next = new Set(current);
      if (next.has(notice.id)) next.delete(notice.id);
      else next.add(notice.id);
      return next;
    });
    if (
      !expanding ||
      licenseTexts[notice.id] ||
      loadingLicenseIds.has(notice.id)
    )
      return;

    setLoadingLicenseIds(current => new Set(current).add(notice.id));
    setLicenseErrors(current => {
      const next = { ...current };
      delete next[notice.id];
      return next;
    });
    const asset = Asset.fromModule(notice.licenseAsset);
    asset
      .downloadAsync()
      .then(downloaded =>
        new File(downloaded.localUri || downloaded.uri).text(),
      )
      .then(text =>
        setLicenseTexts(current => ({ ...current, [notice.id]: text })),
      )
      .catch(error => {
        const message = String(error);
        setLicenseErrors(current => ({ ...current, [notice.id]: message }));
        Alert.alert(
          t('licenses.loadError', { project: notice.projectName }),
          message,
        );
      })
      .finally(() => {
        setLoadingLicenseIds(current => {
          const next = new Set(current);
          next.delete(notice.id);
          return next;
        });
      });
  };

  const openSource = (projectName: string, sourceUrl: string) => {
    Linking.openURL(sourceUrl).catch(error => {
      Alert.alert(
        t('licenses.sourceError', { project: projectName }),
        String(error),
      );
    });
  };

  return (
    <View className="flex-1">
      <ScreenHeader
        title={t('licenses.title')}
        subtitle={t('licenses.count', { count: OPEN_SOURCE_LICENSES.length })}
        left={
          <IconButton
            icon={ChevronLeft}
            accessibilityLabel={t('connection.back')}
            onPress={onClose}
          />
        }
      />
      <ScrollView className="flex-1">
        <View className="p-4 pb-10">
          <GlassSurface className="mb-5 flex-row items-start gap-3 rounded-lg border border-white/30 p-4 dark:border-white/10">
            <Icon as={Scale} className="text-primary" size={21} />
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold">
                {t('licenses.openSourceSoftware')}
              </Text>
              <Text className="mt-1 text-xs leading-[18px] text-muted-foreground">
                {t('licenses.copy')}
              </Text>
            </View>
          </GlassSurface>

          {OPEN_SOURCE_LICENSES.map((notice, index) => {
            const licenseExpanded = expandedLicenseIds.has(notice.id);
            const licenseText = licenseTexts[notice.id];
            const licenseLoading = loadingLicenseIds.has(notice.id);
            const licenseError = licenseErrors[notice.id];
            const section = notice.category ?? 'featured';
            const previousSection =
              index > 0
                ? OPEN_SOURCE_LICENSES[index - 1].category ?? 'featured'
                : null;
            return (
              <Fragment key={notice.id}>
                {section !== previousSection ? (
                  <Text
                    className={
                      index === 0
                        ? 'mb-3 px-1 text-sm font-semibold text-muted-foreground'
                        : 'mb-3 mt-5 px-1 text-sm font-semibold text-muted-foreground'
                    }
                  >
                    {t(`licenses.section.${section}`)}
                  </Text>
                ) : null}
                <GlassSurface className="mb-3 overflow-hidden rounded-lg border border-white/30 dark:border-white/10">
                  <View className="p-4">
                    <View className="flex-row items-start gap-3">
                      <View className="size-10 items-center justify-center rounded-full bg-primary/10">
                        <Icon as={Scale} className="text-primary" size={18} />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className="text-[16px] font-semibold leading-5">
                          {notice.projectName}
                        </Text>
                        <Text className="mt-0.5 text-xs font-medium leading-[17px] text-muted-foreground">
                          {notice.licenseName}
                        </Text>
                      </View>
                    </View>
                    <Text className="mt-3 text-sm leading-5 text-muted-foreground">
                      {notice.attributionKey
                        ? t(notice.attributionKey, {
                            defaultValue: notice.attribution,
                          })
                        : notice.attribution}
                    </Text>
                    {notice.copyright ? (
                      <Text className="mt-2 text-xs leading-[18px] text-muted-foreground">
                        {notice.copyright}
                      </Text>
                    ) : null}
                    <Button
                      accessibilityRole="link"
                      className="mt-2 h-auto min-h-11 justify-start gap-1.5 px-0"
                      size="content"
                      variant="link"
                      onPress={hapticPress(() =>
                        openSource(notice.projectName, notice.sourceUrl),
                      )}
                    >
                      <Text className="text-sm font-semibold text-primary underline">
                        {t('licenses.viewSource')}
                      </Text>
                      <Icon
                        as={ExternalLink}
                        className="text-primary"
                        size={14}
                      />
                    </Button>
                  </View>
                  <Button
                    accessibilityLabel={
                      licenseExpanded
                        ? t('licenses.collapseLicense', {
                            project: notice.projectName,
                          })
                        : t('licenses.expandLicense', {
                            project: notice.projectName,
                          })
                    }
                    accessibilityState={{ expanded: licenseExpanded }}
                    className="h-auto min-h-14 w-full justify-start rounded-none border-t border-border bg-transparent px-4 py-3"
                    variant="ghost"
                    onPress={hapticPress(() => toggleLicense(notice))}
                  >
                    <Text className="min-w-0 flex-1 text-sm font-semibold leading-5">
                      {t(
                        licenseExpanded
                          ? 'licenses.hideLicense'
                          : 'licenses.viewLicense',
                        { license: notice.licenseName },
                      )}
                    </Text>
                    <Icon
                      as={licenseExpanded ? ChevronUp : ChevronDown}
                      className="text-muted-foreground"
                      size={19}
                    />
                  </Button>
                  {licenseExpanded ? (
                    <Text
                      className="border-t border-border px-4 py-4 font-mono text-xs leading-[18px] text-muted-foreground"
                      selectable
                    >
                      {licenseLoading
                        ? t('licenses.loading')
                        : licenseError ||
                          licenseText ||
                          t('common.unavailable')}
                    </Text>
                  ) : null}
                </GlassSurface>
              </Fragment>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
