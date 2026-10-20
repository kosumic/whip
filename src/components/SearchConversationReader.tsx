import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, View } from 'react-native';
import { ArrowLeft } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { readSearchConversation } from 'react-native-whip-ssh';
import type { AgentChatState } from '../agentChat';
import type { ConversationSearchTarget } from './HerdConversationSearch';
import { agentChatStateFromNative } from '../lib/nativeAgentTranscript';
import type { RemoteFileClient } from '../services/remoteFileTransfer';
import type { TranscriptFileLinkTarget } from '../lib/transcriptLinks';
import { operationalErrorDetails, recordOperationalDiagnostic } from '../services/operationalDiagnostics';
import { hapticPress } from '../services/interactionFeedback';
import { useTheme } from '../theme';
import { AgentChatView } from './AgentChatView';
import { FullScreenOverlay } from './FullScreenOverlay';
import { Button } from './ui/button';
import { Text } from './ui/text';

const READER_REFRESH_MS = 800;

/** A conversation is addressable by identity even after its pane disappears. */
export function SearchConversationReader({ target, hostLabel, imageClient, onClose, onOpenFile, onOpenTerminal }: {
  target: ConversationSearchTarget; hostLabel: string; imageClient?: RemoteFileClient;
  onClose: () => void; onOpenFile?: (target: TranscriptFileLinkTarget) => void; onOpenTerminal?: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [state, setState] = useState<AgentChatState>();
  const [error, setError] = useState(false);
  const [searchOpen, setSearchOpen] = useState(true);
  const [fileUnavailable, setFileUnavailable] = useState(false);
  const hasState = useRef(false);
  const initialTarget = useMemo(() => ({ query: target.query, documentId: target.match.excerpt.documentId, offset: target.match.excerpt.offset }), [target]);
  const { namespace, agent, sessionId } = target.conversation;
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => subscription.remove();
  }, [onClose]);
  useEffect(() => {
    let disposed = false;
    let running = false;
    let version: string | undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (disposed || running || AppState.currentState === 'background') return;
      running = true;
      try {
        const snapshot = await readSearchConversation(namespace, agent, sessionId, version);
        if (!disposed && snapshot) {
          version = snapshot.version;
          live = snapshot.live;
          hasState.current = true;
          setState(agentChatStateFromNative(snapshot.state));
          setError(false);
        }
      } catch (reason) {
        if (!disposed) {
          setError(true);
          if (!hasState.current) live = false;
          recordOperationalDiagnostic('warn', 'Application', 'search-conversation-read-failed', operationalErrorDetails(reason));
        }
      } finally {
        running = false;
        if (!disposed && live) timer = setTimeout(() => { void run(); }, READER_REFRESH_MS);
      }
    };
    void run();
    const subscription = AppState.addEventListener('change', status => {
      if (status === 'active' && !running) { clearTimeout(timer); void run(); }
    });
    return () => { disposed = true; clearTimeout(timer); subscription.remove(); };
  }, [namespace, agent, sessionId]);
  return <FullScreenOverlay>
    <View className="flex-row items-center gap-3 border-b border-border px-3 py-2">
      <Button accessibilityLabel={t('herd.backToSearch')} size="icon" variant="ghost" onPress={hapticPress(onClose)}><ArrowLeft size={22} color={colors.text} /></Button>
      <View className="flex-1"><Text className="font-semibold" numberOfLines={1}>{target.conversation.title || t('herd.untitledConversation')}</Text><Text className="text-xs text-muted-foreground" numberOfLines={1}>{hostLabel}</Text></View>
      {onOpenTerminal ? <Button size="sm" variant="ghost" onPress={hapticPress(onOpenTerminal)}><Text>{t('herd.openTerminal')}</Text></Button> : null}
    </View>
    {error ? <Text className="px-4 py-2 text-sm text-destructive">{t(hasState.current ? 'herd.conversationRefreshUnavailable' : 'herd.conversationUnavailable')}</Text> : null}
    {fileUnavailable ? <Text className="px-4 py-2 text-sm text-muted-foreground">{t('savedChats.filesUnavailable')}</Text> : null}
    <View className="flex-1">
      {state ? <AgentChatView state={state} agent={agent} agentStatus="idle" imageClient={imageClient}
        conversationSearchNamespace={namespace} initialSearchTarget={initialTarget}
        contentInsets={{ top: 0, bottom: 24 }} latestButtonBottom={24}
        searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)}
        onOpenFile={file => { if (onOpenFile) onOpenFile(file); else setFileUnavailable(true); }} /> : !error ? <ActivityIndicator className="mt-10" /> : null}
    </View>
  </FullScreenOverlay>;
}
