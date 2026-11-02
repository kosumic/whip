import Server from 'lucide-react-native/icons/server';
import Trash2 from 'lucide-react-native/icons/trash';
import { useTranslation } from 'react-i18next';

import { DEFAULT_SSH_PORT, hostDisplayName } from '../lib/hostProfiles';
import type { HostProfile } from '../types';
import { ConfirmationPopup } from './ConfirmationPopup';

interface Props {
  busy: boolean;
  host: HostProfile | null;
  onCancel: () => void;
  onDelete: () => void;
}

function sshDestination(host: HostProfile | null): string {
  if (!host) return '';
  const hostname = host.host.includes(':') && !host.host.startsWith('[')
    ? `[${host.host}]`
    : host.host;
  return `${host.username}@${hostname}${host.port === DEFAULT_SSH_PORT ? '' : `:${host.port}`}`;
}

export function DeleteHostConfirmationPopup({ busy, host, onCancel, onDelete }: Props) {
  const { t } = useTranslation();
  return (
    <ConfirmationPopup
      busy={busy}
      confirmLabel={t('common.delete')}
      copy={t('app.deleteHostCopy', { host: host ? hostDisplayName(host) : '' })}
      detail={sshDestination(host)}
      detailIcon={Server}
      icon={Trash2}
      title={t('app.deleteHostTitle')}
      visible={host !== null}
      onCancel={onCancel}
      onConfirm={onDelete}
    />
  );
}
