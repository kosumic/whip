import { Check, Heart, Send } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  createTipIntent,
  isFeedbackApiConfigured,
  submitFeedbackRequest,
} from '@/src/services/feedbackApi';
import {
  getRevenueCatAppUserId,
  loadTipProducts,
  purchaseTipProduct,
  type TipProduct,
} from '@/src/services/revenueCat';
import { hapticPress } from './app-ui';
import { CollapsibleSectionCard } from './CollapsibleSectionCard';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';

type SubmittedRequest = {
  id: string;
  revenueCatUserId: string | null;
};

export function FeedbackSection() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<SubmittedRequest | null>(null);
  const [products, setProducts] = useState<TipProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [tipError, setTipError] = useState<string | null>(null);
  const [purchasingProductId, setPurchasingProductId] = useState<string | null>(
    null,
  );
  const [tipped, setTipped] = useState(false);

  useEffect(() => {
    if (!submitted?.revenueCatUserId) return;
    let mounted = true;
    setProductsLoading(true);
    loadTipProducts()
      .then(value => {
        if (mounted) setProducts(value);
      })
      .catch(() => {
        if (mounted) setProducts([]);
      })
      .finally(() => {
        if (mounted) setProductsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [submitted]);

  const reset = () => {
    setTitle('');
    setBody('');
    setError(null);
    setSubmitted(null);
    setProducts([]);
    setTipError(null);
    setPurchasingProductId(null);
    setTipped(false);
  };

  const submit = async () => {
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle || !trimmedBody) {
      setError(t('feedback.required'));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const revenueCatUserId = await getRevenueCatAppUserId();
      const request = await submitFeedbackRequest({
        title: trimmedTitle,
        body: trimmedBody,
        revenueCatUserId,
      });
      setSubmitted({ id: request.id, revenueCatUserId });
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const purchase = async (product: TipProduct) => {
    if (!submitted?.revenueCatUserId || purchasingProductId) return;
    setPurchasingProductId(product.id);
    setTipError(null);
    try {
      await createTipIntent({
        requestId: submitted.id,
        revenueCatUserId: submitted.revenueCatUserId,
        productId: product.id,
      });
      const result = await purchaseTipProduct(product);
      if (result === 'purchased') setTipped(true);
    } catch (purchaseError) {
      setTipError(
        purchaseError instanceof Error
          ? purchaseError.message
          : String(purchaseError),
      );
    } finally {
      setPurchasingProductId(null);
    }
  };

  return (
    <View className="px-4 py-2">
      <CollapsibleSectionCard
        title={t('feedback.title')}
        description={t('feedback.copy')}
        expanded={expanded}
        onToggle={() => setExpanded(value => !value)}
        contentClassName="p-4"
      >
        {submitted ? (
          <View>
            <View className="flex-row items-center gap-2">
              <Icon as={Check} className="text-success" size={21} />
              <Text className="text-[17px] font-semibold leading-6">
                {t('feedback.submitted')}
              </Text>
            </View>
            {tipped ? (
              <View className="mt-5 items-center py-3">
                <Icon as={Heart} className="text-primary" size={28} />
                <Text
                  accessibilityLiveRegion="polite"
                  className="mt-3 text-center text-[17px] font-semibold"
                >
                  {t('feedback.tipThanks')}
                </Text>
                <Button
                  className="mt-5"
                  variant="outline"
                  onPress={hapticPress(reset)}
                >
                  <Text>{t('feedback.another')}</Text>
                </Button>
              </View>
            ) : (
              <View className="mt-5">
                <Text className="text-[17px] font-semibold leading-6">
                  {t('feedback.tipTitle')}
                </Text>
                <Text className="mt-1 text-sm leading-5 text-muted-foreground">
                  {t('feedback.tipCopy')}
                </Text>
                {productsLoading ? (
                  <View className="mt-5 flex-row items-center gap-2">
                    <ActivityIndicator />
                    <Text className="text-sm text-muted-foreground">
                      {t('feedback.loadingTips')}
                    </Text>
                  </View>
                ) : products.length ? (
                  <View className="mt-5 flex-row gap-2">
                    {products.map(product => (
                      <Button
                        key={product.id}
                        accessibilityLabel={t('feedback.tipAmount', {
                          price: product.localizedPrice,
                        })}
                        className="min-w-0 flex-1"
                        disabled={purchasingProductId !== null}
                        variant="outline"
                        onPress={hapticPress(() => purchase(product))}
                      >
                        {purchasingProductId === product.id ? (
                          <ActivityIndicator size="small" />
                        ) : null}
                        <Text numberOfLines={1}>{product.localizedPrice}</Text>
                      </Button>
                    ))}
                  </View>
                ) : (
                  <Text className="mt-4 text-sm leading-5 text-muted-foreground">
                    {t('feedback.tipsUnavailable')}
                  </Text>
                )}
                {tipError ? (
                  <Text
                    accessibilityLiveRegion="polite"
                    className="mt-3 text-sm text-destructive"
                  >
                    {tipError}
                  </Text>
                ) : null}
                <Button
                  className="mt-3 self-start px-0"
                  variant="link"
                  onPress={hapticPress(reset)}
                >
                  <Text>{t('feedback.notNow')}</Text>
                </Button>
              </View>
            )}
          </View>
        ) : (
          <View>
            <Input
              editable={!submitting}
              maxLength={120}
              placeholder={t('feedback.requestTitle')}
              value={title}
              onChangeText={setTitle}
            />
            <Input
              className="mt-3 h-32 items-start py-3"
              editable={!submitting}
              maxLength={5000}
              multiline
              placeholder={t('feedback.details')}
              textAlignVertical="top"
              value={body}
              onChangeText={setBody}
            />
            {!isFeedbackApiConfigured() ? (
              <Text className="mt-3 text-sm leading-5 text-muted-foreground">
                {t('feedback.serviceUnavailable')}
              </Text>
            ) : null}
            {error ? (
              <Text
                accessibilityLiveRegion="polite"
                className="mt-3 text-sm text-destructive"
              >
                {error}
              </Text>
            ) : null}
            <Button
              className="mt-4"
              disabled={submitting || !isFeedbackApiConfigured()}
              onPress={hapticPress(submit)}
            >
              {submitting ? (
                <ActivityIndicator size="small" />
              ) : (
                <Icon as={Send} size={17} />
              )}
              <Text>
                {submitting ? t('feedback.submitting') : t('feedback.submit')}
              </Text>
            </Button>
            <Text className="mt-3 text-xs leading-[18px] text-muted-foreground">
              {t('feedback.free')}
            </Text>
          </View>
        )}
      </CollapsibleSectionCard>
    </View>
  );
}
