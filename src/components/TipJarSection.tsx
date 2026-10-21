import { Heart } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  loadTipJarProduct,
  purchaseTipProduct,
  type TipJarProduct,
} from '../services/revenueCat';
import { hapticPress } from './app-ui';
import { CollapsibleSectionCard } from './CollapsibleSectionCard';
import { GlassButton } from './GlassControls';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export function TipJarSection() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [product, setProduct] = useState<TipJarProduct | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [purchasing, setPurchasing] = useState(false);
  const [result, setResult] = useState<
    'purchased' | 'pending' | 'error' | null
  >(null);
  const purchaseInProgress = useRef(false);

  useEffect(() => {
    if (!expanded) return;
    let mounted = true;
    setLoading(true);
    loadTipJarProduct()
      .then(value => {
        if (mounted) setProduct(value);
      })
      .catch(() => {
        if (mounted) setProduct(null);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [expanded, reload]);

  const purchase = async () => {
    if (!product || purchaseInProgress.current) return;
    purchaseInProgress.current = true;
    setPurchasing(true);
    setResult(null);
    try {
      const outcome = await purchaseTipProduct(product);
      if (outcome !== 'cancelled') setResult(outcome);
    } catch {
      setResult('error');
    } finally {
      purchaseInProgress.current = false;
      setPurchasing(false);
    }
  };

  return (
    <View className="px-4 py-2">
      <CollapsibleSectionCard
        title={t('tipJar.title')}
        icon={Heart}
        description={t('tipJar.copy')}
        expanded={expanded}
        onToggle={() => setExpanded(value => !value)}
        contentClassName="p-4"
      >
        <Text className="text-sm leading-5 text-muted-foreground">
          {t('tipJar.optional')}
        </Text>
        {loading ? (
          <View className="mt-4 flex-row items-center gap-2">
            <ActivityIndicator />
            <Text className="text-sm text-muted-foreground">
              {t('tipJar.loading')}
            </Text>
          </View>
        ) : product ? (
          <GlassButton
            accessibilityLabel={t('tipJar.amount', {
              price: product.localizedPrice,
            })}
            className="mt-4"
            disabled={purchasing || result === 'pending'}
            onPress={hapticPress(purchase)}
          >
            {purchasing ? (
              <ActivityIndicator size="small" />
            ) : (
              <Icon as={Heart} size={18} />
            )}
            <Text>{t('tipJar.amount', { price: product.localizedPrice })}</Text>
          </GlassButton>
        ) : (
          <View className="mt-4">
            <Text
              accessibilityLiveRegion="polite"
              className="text-sm leading-5 text-muted-foreground"
            >
              {t('tipJar.unavailable')}
            </Text>
            <GlassButton
              className="mt-3"
              variant="outline"
              onPress={hapticPress(() => setReload(value => value + 1))}
            >
              <Text>{t('tipJar.retry')}</Text>
            </GlassButton>
          </View>
        )}
        {result ? (
          <Text
            accessibilityLiveRegion="polite"
            className={
              result === 'error'
                ? 'mt-3 text-sm leading-5 text-destructive'
                : 'mt-3 text-sm leading-5 text-muted-foreground'
            }
          >
            {t(
              result === 'purchased'
                ? 'tipJar.thanks'
                : result === 'pending'
                  ? 'tipJar.pending'
                  : 'tipJar.error',
            )}
          </Text>
        ) : null}
      </CollapsibleSectionCard>
    </View>
  );
}
