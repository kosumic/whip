import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import Phone from 'lucide-react-native/icons/phone';
import { GlobalCallContext } from '../lib/globalCallContext';
import { IconButton } from './app-ui';

export function GlobalCallButton() {
  const { t } = useTranslation();
  const open = useContext(GlobalCallContext);
  return <IconButton icon={Phone} accessibilityLabel={t('globalCall.open')} onPress={open} />;
}
