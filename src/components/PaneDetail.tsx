import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { ArrowDown, ArrowUp, Maximize2, PanelBottomOpen, PanelRightOpen, RefreshCw, SquareTerminal, Trash2, X, type LucideIcon } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AnsiOutput } from './AnsiOutput';
import type { HerdrClient } from '@/src/services/HerdrClient';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { colors, useTheme } from '@/src/theme';
import { APP_FROSTED_GLASS_SURFACE_PROPS, appGlassBackgroundClassName } from '@/src/lib/appGlass';
import { cn } from '@/src/lib/utils';
import type { PaneInfo } from '@/src/types';
import { hapticPress, IconButton, StatusBadge } from './app-ui';
import { AppAlertPopup, type AppAlertContent } from './AppAlertPopup';
import { ConfirmationPopup } from './ConfirmationPopup';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props { pane: PaneInfo | null; client: HerdrClient; onClose: () => void; onOpenTerminal: (pane: PaneInfo) => void }

const PANE_KEY_CONTROLS: readonly {
  key: string;
  label?: string;
  icon?: LucideIcon;
  accessibilityKey?: string;
}[] = [
  { key: 'esc', label: 'ESC' },
  { key: 'ctrl+c', label: 'CTRL+C' },
  { key: 'tab', label: 'TAB' },
  { key: 'up', icon: ArrowUp, accessibilityKey: 'terminal.upKey' },
  { key: 'down', icon: ArrowDown, accessibilityKey: 'terminal.downKey' },
  { key: 'enter', label: 'ENTER' },
];

async function loadPane(client: HerdrClient, pane: PaneInfo, setOutput: (value: string) => void, errorText: (error: unknown) => string) {
  try {
    const result = await client.native.requestHerdrApi({
      method: 'pane.read',
      params: {
        pane_id: pane.pane_id,
        source: 'recent',
        lines: 160,
        format: 'ansi',
        strip_ansi: false,
      },
    });
    if (result.type !== 'pane_read') {
      throw new Error(`Unexpected pane.read result: ${result.type}`);
    }
    setOutput(result.read.text);
  } catch (error) {
    setOutput(errorText(error));
  }
}

export function PaneDetail({ pane, client, onClose, onOpenTerminal }: Props) {
  const { colors: theme } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const { t } = useTranslation();
  const loadedPaneId = useRef<string | null>(null);
  const [output, setOutput] = useState('');
  const [command, setCommand] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [appAlert, setAppAlert] = useState<AppAlertContent | null>(null);
  const [closeConfirmationOpen, setCloseConfirmationOpen] = useState(false);
  const read = () => {
    if (!pane) return;
    reportBackgroundFailure(
      loadPane(client, pane, setOutput, error => t('pane.readError', { error: String(error) })),
      'pane-output-read',
    );
  };

  useEffect(() => {
    if (!pane) {
      loadedPaneId.current = null;
      setAppAlert(null);
      setCloseConfirmationOpen(false);
      return;
    }
    if (loadedPaneId.current !== pane.pane_id) {
      loadedPaneId.current = pane.pane_id;
      setLabel(pane.label || '');
      setOutput('');
      setAppAlert(null);
      setCloseConfirmationOpen(false);
    }
    reportBackgroundFailure(
      loadPane(client, pane, setOutput, error => t('pane.readError', { error: String(error) })),
      'pane-output-read',
    );
  }, [client, pane, t]);
  if (!pane) return null;

  const run = (action: () => Promise<unknown>, close = false) => {
    reportBackgroundFailure((async () => {
      setBusy(true);
      try {
        await action();
        if (close) onClose();
        else await loadPane(
          client,
          pane,
          setOutput,
          error => t('pane.readError', { error: String(error) }),
        );
      } catch (error) {
        setAppAlert({
          title: t('herd.commandFailed'),
          message: String(error),
        });
      } finally {
        setBusy(false);
      }
    })(), 'pane-action');
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" automaticOffset className="flex-1 justify-end" style={{ backgroundColor: theme.scrim }}>
        <GlassSurface {...APP_FROSTED_GLASS_SURFACE_PROPS} className="h-[94%] rounded-t-[28px] p-4" fallbackClassName="bg-background">
          <View className="mb-3.5 h-1 w-9 self-center rounded-full bg-border" />
          <View className="flex-row items-center gap-2.5"><View className="flex-1"><Text className="text-[11px] leading-[15px] text-muted-foreground">{pane.workspace_id} · {pane.tab_id} · {pane.pane_id}</Text><Text className="mt-0.5 text-xl font-semibold leading-[26px]" numberOfLines={1}>{pane.label || pane.display_agent || pane.agent || t('pane.titleFallback')}</Text></View><StatusBadge agentStatus status={pane.agent_status} /><IconButton icon={X} accessibilityLabel={t('pane.closeDetails')} onPress={onClose} /></View>
          <View className="mt-3.5 flex-row items-center gap-2"><Input className="flex-1" value={label} onChangeText={setLabel} placeholder={t('pane.label')} /><Button size="sm" variant="secondary" disabled={busy} onPress={hapticPress(() => run(() => client.native.requestHerdrApi({ method: 'pane.rename', params: { pane_id: pane.pane_id, label: label.trim() || null } })))}><Text>{t('common.save')}</Text></Button></View>
          <View className="my-3 flex-row items-center gap-1.5"><Action label={t('pane.splitRight')} icon={PanelRightOpen} onPress={() => run(() => client.native.requestHerdrApi({ method: 'pane.split', params: { target_pane_id: pane.pane_id, direction: 'right', focus: true } }))} /><Action label={t('pane.splitDown')} icon={PanelBottomOpen} onPress={() => run(() => client.native.requestHerdrApi({ method: 'pane.split', params: { target_pane_id: pane.pane_id, direction: 'down', focus: true } }))} /><IconButton icon={Maximize2} accessibilityLabel={t('pane.zoom')} onPress={() => run(() => client.native.requestHerdrApi({ method: 'pane.zoom', params: { pane_id: pane.pane_id, mode: 'toggle' } }))} /><Button size="sm" onPress={hapticPress(() => onOpenTerminal(pane))}><Icon as={SquareTerminal} size={16} color={theme.onPrimary} /><Text>{t('pane.open')}</Text></Button></View>
          <View className="min-h-9 flex-row items-center justify-between"><Text className="text-sm font-semibold">{t('pane.liveOutput')}</Text><IconButton icon={RefreshCw} accessibilityLabel={t('pane.refreshOutput')} className="size-[34px]" onPress={read} /></View>
          <View className={cn('flex-1 overflow-hidden rounded-md', appGlassBackgroundClassName(appGlassEnabled, 'bg-terminal-canvas'))}>{output ? <AnsiOutput value={output} /> : <ActivityIndicator color={colors.acid} className="flex-1" />}</View>
          <View className="mt-2 flex-row gap-1">
            {PANE_KEY_CONTROLS.map(({ key, label: keyLabel, icon, accessibilityKey }) => (
              <Button
                key={key}
                accessibilityLabel={accessibilityKey ? t(accessibilityKey) : keyLabel}
                className="h-[34px] flex-1 rounded-sm bg-terminal-surface px-1"
                variant="secondary"
                onPress={hapticPress(() => run(() => client.native.requestHerdrApi({ method: 'pane.send_keys', params: { pane_id: pane.pane_id, keys: [key] } })))}
              >
                {icon ? (
                  <Icon as={icon} size={18} className="text-terminal-text" />
                ) : (
                  <Text className="font-mono text-[8px] text-terminal-text">{keyLabel}</Text>
                )}
              </Button>
            ))}
          </View>
          <View className={cn('mt-2.5 min-h-[52px] flex-row items-center rounded-full border border-border py-1 pl-3.5 pr-1.5', appGlassBackgroundClassName(appGlassEnabled, 'bg-card'))}><Input className="h-10 flex-1 border-0 bg-transparent px-0 shadow-none" value={command} onChangeText={setCommand} placeholder={t('pane.sendPlaceholder')} /><IconButton icon={ArrowUp} accessibilityLabel={t('pane.send')} disabled={!command.trim() || busy} selected={Boolean(command.trim())} onPress={() => run(async () => { await client.native.requestHerdrApi({ method: 'pane.send_input', params: { pane_id: pane.pane_id, text: command, keys: ['enter'] } }); setCommand(''); })} /></View>
          <Button className="mt-2 rounded-full" variant="destructive" onPress={hapticPress(() => setCloseConfirmationOpen(true))}><Icon as={Trash2} size={17} color="#FFFFFF" /><Text>{t('pane.closePane')}</Text></Button>
        </GlassSurface>
      </KeyboardAvoidingView>
      <ConfirmationPopup
        busy={busy}
        confirmLabel={t('common.close')}
        copy={pane.label || pane.pane_id}
        icon={Trash2}
        title={t('pane.closeTitle')}
        visible={closeConfirmationOpen}
        onCancel={() => setCloseConfirmationOpen(false)}
        onConfirm={() => {
          setCloseConfirmationOpen(false);
          run(() => client.native.requestHerdrApi({ method: 'pane.close', params: { pane_id: pane.pane_id } }), true);
        }}
      />
      <AppAlertPopup
        message={appAlert?.message}
        title={appAlert?.title || ''}
        visible={appAlert !== null}
        onClose={() => setAppAlert(null)}
      />
    </Modal>
  );
}

function Action({ label, icon, onPress }: { label: string; icon: LucideIcon; onPress: () => void }) { const { colors: theme } = useTheme(); return <Button size="sm" variant="secondary" onPress={hapticPress(onPress)}><Icon as={icon} size={15} color={theme.text} /><Text>{label}</Text></Button>; }
