import { Download, SquareTerminal } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { RuntimeHerdrSetup } from 'react-native-whip-ssh';

import type { HerdHostQueue } from '../herdQueue';
import type { HerdrInstallProgress } from '../hooks/useHerdrInstallation';
import { hapticPress } from './app-ui';
import { HerdrInstallPopup } from './HerdrInstallPopup';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  queue: HerdHostQueue;
  progress?: HerdrInstallProgress;
  onCheck: (hostId: string) => Promise<RuntimeHerdrSetup>;
  onInstall: (hostId: string, command: string) => Promise<void>;
  onStart: (hostId: string) => Promise<void>;
  onOpenSsh: (hostId: string) => void;
}

export function HerdHostSetup({ queue, progress, onCheck, onInstall, onStart, onOpenSsh }: Props) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<RuntimeHerdrSetup | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkRevision, setCheckRevision] = useState(0);
  const [popupOpen, setPopupOpen] = useState(false);
  const [command, setCommand] = useState('');
  const submitting = useRef(false);
  const installing = progress?.phase === 'installing';

  useEffect(() => {
    if (queue.running || queue.refreshing || installing) return;
    let current = true;
    setChecking(true);
    setSetup(null);
    setCheckError(null);
    onCheck(queue.id).then(value => {
      if (!current) return;
      setSetup(value);
      setCommand(value.installCommand);
    }).catch(error => {
      if (current) setCheckError(String(error));
    }).finally(() => {
      if (current) setChecking(false);
    });
    return () => { current = false; };
  }, [queue.id, queue.running, queue.refreshing, installing, checkRevision, onCheck]);

  const install = async () => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      await onInstall(queue.id, progress?.command || command);
    } catch (error) {
      setCheckError(String(error));
    } finally {
      submitting.current = false;
    }
  };
  const missing = setup?.status === 'missing';
  const customMissing = setup?.status === 'custom-command-missing';

  return (
    <>
      {!queue.running ? (
        <View className="min-h-[360px] items-center justify-center p-7">
          <View className="size-16 items-center justify-center rounded-full bg-muted">
            <Icon as={missing ? Download : SquareTerminal} size={28} />
          </View>
          <Text className="mt-[18px] text-center text-xl font-semibold leading-[26px]">
            {t(installing ? 'herd.installProgress' : missing ? 'herd.herdrMissing' : customMissing ? 'herd.customCommandMissing' : 'herd.serverOffline')}
          </Text>
          <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
            {t(installing ? 'herd.installBackgroundCopy' : missing ? 'herd.herdrMissingCopy' : customMissing ? 'herd.customCommandMissingCopy' : 'herd.serverOfflineCopy', { host: queue.label })}
          </Text>
          {checkError ? <Text selectable className="mt-3 text-center text-sm text-destructive">{checkError}</Text> : null}
          <View className="mt-6 flex-row flex-wrap justify-center gap-2.5">
            {installing ? (
              <Button className="rounded-full px-5" onPress={hapticPress(() => setPopupOpen(true))}>
                <Text>{t('herd.installOutput')}</Text>
              </Button>
            ) : missing ? (
              <Button className="rounded-full px-5" onPress={hapticPress(() => setPopupOpen(true))}>
                <Text>{t('herd.installHerdr')}</Text>
              </Button>
            ) : (
              <Button
                className="rounded-full px-5"
                disabled={checking || queue.refreshing}
                onPress={hapticPress(() => {
                  if (customMissing || checkError) setCheckRevision(value => value + 1);
                  else onStart(queue.id).catch(error => setCheckError(String(error)));
                })}
              >
                <Text>{t(checking ? 'herd.checkingHerdr' : queue.refreshing ? 'herd.starting' : customMissing || checkError ? 'herd.checkAgain' : 'herd.startServer')}</Text>
              </Button>
            )}
            <Button className="rounded-full px-5" variant="secondary" onPress={hapticPress(() => onOpenSsh(queue.id))}>
              <Icon as={SquareTerminal} size={17} />
              <Text>{t('herd.openSshShell')}</Text>
            </Button>
            {progress && !installing ? (
              <Button variant="ghost" onPress={hapticPress(() => setPopupOpen(true))}>
                <Text>{t('herd.installOutput')}</Text>
              </Button>
            ) : null}
          </View>
          {missing && !installing ? (
            <Button className="mt-2" variant="ghost" disabled={checking} onPress={hapticPress(() => setCheckRevision(value => value + 1))}>
              <Text>{t('herd.checkAgain')}</Text>
            </Button>
          ) : null}
        </View>
      ) : progress ? (
        <Button className="mb-3 self-start" variant="ghost" onPress={hapticPress(() => setPopupOpen(true))}>
          <Text>{t('herd.installOutput')}</Text>
        </Button>
      ) : null}
      <HerdrInstallPopup visible={popupOpen} host={queue.label} command={progress?.command || command} progress={progress} onClose={() => setPopupOpen(false)} onInstall={() => { void install(); }} />
    </>
  );
}
