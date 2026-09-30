import type { RuntimePreviewInfo, RuntimeRemoteFileEntry } from 'react-native-whip-ssh';
import { formatGitDiffSelection } from 'react-native-whip-ssh';
import * as WebBrowser from 'expo-web-browser';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, FileCode2, FileMusic, FileText, FileVideo, Folder, FolderOpen, GitCompareArrows, Image as ImageIcon, Pencil, RefreshCw, SlidersHorizontal, Trash2, Upload, X } from 'lucide-react-native';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Modal, PanResponder, Pressable, ScrollView, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { formatRemoteFileSize, isRemoteHiddenPath, parentRemotePath, remoteEntryName, remotePreviewKind, sortRemoteEntries, type RemoteFileSortField, type RemotePreviewKind } from '@/src/lib/remoteFiles';
import { REMOTE_FILE_SWIPE_ACTION_WIDTH, remoteFileSwipeOffset, shouldClaimRemoteFileSwipe, shouldOpenRemoteFileSwipe } from '@/src/lib/remoteFileSwipeActions';
import { DEFAULT_SPRING_CONFIG } from '@/src/lib/motion';
import { buildRemoteGitTreeRows, isRemoteGitEntryDeleted, remoteGitStatusLabel, type RemoteGitDiff, type RemoteGitRepository, type RemoteGitStatusEntry } from '@/src/lib/remoteGit';
import type { HerdrClient } from '@/src/services/HerdrClient';
import { cacheRemoteFile, copyCachedRemoteFileToPickedDirectory, pickLocalFileForUpload, saveCachedRemoteText, type CachedRemoteFile } from '@/src/services/remoteFileTransfer';
import { bestEffortCleanup, reportBackgroundFailure } from '../services/backgroundOperations';
import { useRemoteFileViewPreferences } from '@/src/hooks/useRemoteFileViewPreferences';
import { loadRemoteGitCollapsedPaths, loadRemoteGitMode, saveRemoteGitCollapsedPaths, saveRemoteGitMode } from '@/src/services/remoteGitPreferences';
import { colorWithAlpha, useTheme, type ThemeColors } from '@/src/theme';
import { hapticPress } from './app-ui';
import { CodeEditor, CodePreview } from './CodePreview';
import { ConfirmationPopup } from './ConfirmationPopup';
import { HtmlPreview } from './HtmlPreview';
import { MarkdownPreview } from './MarkdownPreview';
import { MermaidPreview } from './MermaidPreview';
import { RemoteGitDiffPreview } from './RemoteGitDiffPreview';
import { RemoteAudioPreview } from './RemoteAudioPreview';
import { RemoteTextPreview } from './RemoteTextPreview';
import { RemoteVideoPreview } from './RemoteVideoPreview';
import { SvgPreview } from './SvgPreview';
import { ZoomableImagePreview } from './ZoomableImagePreview';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Switch } from './ui/switch';
import { Text } from './ui/text';

const REMOTE_PREVIEW_CLOSE_CONTEXT = 'remote-preview-close';

interface Props {
  onAskAgent?: (text: string) => boolean;
  visible: boolean;
  client: HerdrClient;
  hostId: string;
  initialPath: string;
  initialFilePath?: string;
  initialLine?: number;
  onPathChange: (path: string) => void;
  onClose: () => void;
}

interface FilePreview {
  entry: RuntimeRemoteFileEntry;
  path: string;
  kind: RemotePreviewKind;
  cached: CachedRemoteFile | null;
  content: string | null;
  draft: string;
  editing: boolean;
  error: string | null;
  htmlPreview: RuntimePreviewInfo | null;
  filePreview: RuntimePreviewInfo | null;
  htmlRevision: number;
  gitDiff: RemoteGitDiff | null;
  gitStatus: RemoteGitStatusEntry | null;
  initialLine?: number;
}

const remoteFileSortFields: RemoteFileSortField[] = ['name', 'modified', 'size'];
const remoteGitListContentStyle = {
  paddingHorizontal: 12,
  paddingVertical: 4,
} as const;
const remoteGitTreeIndentStyles = Array.from({ length: 16 }, (_, depth) => ({
  paddingLeft: 8 + depth * 16,
}));

export function RemoteFileManager({ visible, client, hostId, initialPath, initialFilePath, initialLine, onPathChange, onClose, onAskAgent }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const safeAreaInsets = useSafeAreaInsets();
  const fileViewPreferences = useRemoteFileViewPreferences();
  const {
    showHiddenFiles,
    sortField,
    sortDirection,
    setShowHiddenFiles,
    selectSortField,
  } = fileViewPreferences;
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<RuntimeRemoteFileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ directoryPath: string; entry: RuntimeRemoteFileEntry } | null>(null);
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [sortMenuVisible, setSortMenuVisible] = useState(false);
  const [gitRepository, setGitRepository] = useState<RemoteGitRepository | null>(null);
  const [gitMode, setGitMode] = useState(false);
  const [gitStatus, setGitStatus] = useState<RemoteGitStatusEntry[]>([]);
  const [gitCollapsedPaths, setGitCollapsedPaths] = useState<Set<string>>(new Set());
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const previewRef = useRef<FilePreview | null>(null);
  const pathRef = useRef('');
  const requestRef = useRef(0);
  const gitRequestRef = useRef(0);
  const pdfBrowserRequestRef = useRef<number | null>(null);
  const pdfBrowserLeftAppRef = useRef(false);
  const onPathChangeRef = useRef(onPathChange);
  onPathChangeRef.current = onPathChange;
  const visibleEntries = useMemo(() => (showHiddenFiles ? entries : entries.filter(entry => !isRemoteHiddenPath(remoteEntryName(entry)))), [entries, showHiddenFiles]);
  const sortedEntries = useMemo(() => sortRemoteEntries(visibleEntries, sortField, sortDirection), [sortDirection, sortField, visibleEntries]);
  const visibleGitStatus = useMemo(() => (showHiddenFiles ? gitStatus : gitStatus.filter(status => !isRemoteHiddenPath(status.path))), [gitStatus, showHiddenFiles]);
  const gitTreeRows = useMemo(() => buildRemoteGitTreeRows(visibleGitStatus, gitCollapsedPaths), [gitCollapsedPaths, visibleGitStatus]);
  const gitReviewFiles = useMemo(() => buildRemoteGitTreeRows(visibleGitStatus, new Set()).flatMap(row => row.kind === 'file' ? [row.status] : []), [visibleGitStatus]);
  const gitReviewIndex = preview?.gitStatus ? gitReviewFiles.findIndex(status => status.path === preview.gitStatus?.path) : -1;

  const replacePreview = useCallback(
    (next: FilePreview | null) => {
      const previous = previewRef.current;
      if (previous?.cached && previous.cached !== next?.cached) previous.cached.dispose();
      if (previous?.htmlPreview && previous.htmlPreview !== next?.htmlPreview) {
        bestEffortCleanup(client.native.stopPreview(previous.htmlPreview.id), REMOTE_PREVIEW_CLOSE_CONTEXT);
      }
      if (previous?.filePreview && previous.filePreview !== next?.filePreview) {
        bestEffortCleanup(client.native.stopPreview(previous.filePreview.id), REMOTE_PREVIEW_CLOSE_CONTEXT);
      }
      previewRef.current = next;
      setPreview(next);
    },
    [client],
  );

  const loadDirectory = useCallback(
    async (requestedPath: string) => {
      const request = ++requestRef.current;
      gitRequestRef.current += 1;
      setBusy(true);
      setError(null);
      setGitBusy(false);
      setGitError(null);
      setGitRepository(null);
      setGitMode(false);
      setGitStatus([]);
      setGitCollapsedPaths(new Set());
      replacePreview(null);
      try {
        const listing = await client.native.listDirectory(requestedPath);
        if (request !== requestRef.current) return;
        let repository: RemoteGitRepository | null = null;
        let persistedGitMode = false;
        let changes: RemoteGitStatusEntry[] = [];
        let collapsedPaths: string[] = [];
        try {
          repository = await client.native.discoverGitRepository(listing.path);
          if (repository) {
            [persistedGitMode, collapsedPaths] = await Promise.all([loadRemoteGitMode(hostId, repository.root), loadRemoteGitCollapsedPaths(hostId, repository.root)]);
            if (persistedGitMode) changes = await client.native.gitStatus(repository.root);
          }
        } catch (reason) {
          if (persistedGitMode) setGitError(String(reason));
        }
        if (request !== requestRef.current) return;
        pathRef.current = listing.path;
        setPath(listing.path);
        setEntries(listing.entries);
        setGitRepository(repository);
        setGitMode(Boolean(repository && persistedGitMode));
        setGitStatus(changes);
        setGitCollapsedPaths(new Set(collapsedPaths));
        onPathChangeRef.current(listing.path);
      } catch (reason) {
        if (request === requestRef.current) setError(String(reason));
      } finally {
        if (request === requestRef.current) setBusy(false);
      }
    },
    [client, hostId, replacePreview],
  );

  useEffect(() => {
    if (visible && !initialFilePath) {
      reportBackgroundFailure(loadDirectory(initialPath), 'remote-directory-load');
    }
    else {
      requestRef.current += 1;
      gitRequestRef.current += 1;
      replacePreview(null);
    }
  }, [initialFilePath, initialPath, loadDirectory, replacePreview, visible]);

  useEffect(
    () => () => {
      const current = previewRef.current;
      current?.cached?.dispose();
      if (current?.htmlPreview) bestEffortCleanup(client.native.stopPreview(current.htmlPreview.id), REMOTE_PREVIEW_CLOSE_CONTEXT);
      if (current?.filePreview) bestEffortCleanup(client.native.stopPreview(current.filePreview.id), REMOTE_PREVIEW_CLOSE_CONTEXT);
      previewRef.current = null;
    },
    [client],
  );

  const finishPdfBrowser = useCallback(
    (request: number) => {
      if (pdfBrowserRequestRef.current !== request) return;
      pdfBrowserRequestRef.current = null;
      pdfBrowserLeftAppRef.current = false;
      if (request !== requestRef.current || previewRef.current?.kind !== 'pdf') return;
      requestRef.current += 1;
      replacePreview(null);
    },
    [replacePreview],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const request = pdfBrowserRequestRef.current;
      if (request === null) return;
      if (state !== 'active') {
        pdfBrowserLeftAppRef.current = true;
      } else if (pdfBrowserLeftAppRef.current) {
        finishPdfBrowser(request);
      }
    });
    return () => subscription.remove();
  }, [finishPdfBrowser]);

  const openPdfBrowser = async (url: string, request: number) => {
    pdfBrowserRequestRef.current = request;
    pdfBrowserLeftAppRef.current = false;
    try {
      const result = await WebBrowser.openBrowserAsync(url);
      if (result.type !== WebBrowser.WebBrowserResultType.OPENED) finishPdfBrowser(request);
    } catch (reason) {
      if (pdfBrowserRequestRef.current === request) {
        pdfBrowserRequestRef.current = null;
        pdfBrowserLeftAppRef.current = false;
      }
      throw reason;
    }
  };

  const refreshGitChanges = async (repository = gitRepository) => {
    if (!repository) return;
    const request = ++gitRequestRef.current;
    setGitBusy(true);
    setGitError(null);
    try {
      const changes = await client.native.gitStatus(repository.root);
      if (request === gitRequestRef.current) setGitStatus(changes);
    } catch (reason) {
      if (request === gitRequestRef.current) setGitError(String(reason));
    } finally {
      if (request === gitRequestRef.current) setGitBusy(false);
    }
  };

  const toggleGitMode = async () => {
    if (!gitRepository || gitBusy) return;
    const next = !gitMode;
    const request = ++gitRequestRef.current;
    setGitBusy(true);
    setGitError(null);
    try {
      await saveRemoteGitMode(hostId, gitRepository.root, next);
      if (request !== gitRequestRef.current) return;
      setGitMode(next);
      if (next) {
        const changes = await client.native.gitStatus(gitRepository.root);
        if (request === gitRequestRef.current) setGitStatus(changes);
      } else {
        setGitStatus([]);
      }
    } catch (reason) {
      if (request === gitRequestRef.current) setGitError(String(reason));
    } finally {
      if (request === gitRequestRef.current) setGitBusy(false);
    }
  };

  const toggleGitDirectory = (directoryPath: string) => {
    if (!gitRepository) return;
    const repository = gitRepository;
    setGitCollapsedPaths(current => {
      const next = new Set(current);
      if (next.has(directoryPath)) next.delete(directoryPath);
      else next.add(directoryPath);
      reportBackgroundFailure(
        saveRemoteGitCollapsedPaths(hostId, repository.root, [...next]),
        'remote-git-collapse-persist',
      );
      return next;
    });
  };

  const updateShowHiddenFiles = (show: boolean) => {
    setShowHiddenFiles(show);
  };

  const openGitChange = async (status: RemoteGitStatusEntry) => {
    if (!gitRepository) return;
    const request = ++requestRef.current;
    const entryPath = status.absolutePath;
    const entry = remoteGitStatusEntry(status);
    const loadingPreview: FilePreview = {
      entry,
      path: entryPath,
      kind: remotePreviewKind(remoteEntryName(entry), entry.size),
      cached: null,
      content: null,
      draft: '',
      editing: false,
      error: null,
      htmlPreview: null,
      filePreview: null,
      htmlRevision: 0,
      gitDiff: null,
      gitStatus: status,
    };
    replacePreview(loadingPreview);
    try {
      const gitDiff = await client.native.gitDiff(gitRepository, status);
      if (request === requestRef.current) replacePreview({ ...loadingPreview, gitDiff });
    } catch (reason) {
      if (request === requestRef.current) {
        replacePreview({ ...loadingPreview, error: String(reason) });
      }
    }
  };

  const openEntry = async (entry: RuntimeRemoteFileEntry, targetLine?: number) => {
    const name = remoteEntryName(entry);
    const entryPath = entry.path;
    if (entry.kind === 'directory') {
      await loadDirectory(entryPath);
      return;
    }

    const kind = remotePreviewKind(name, entry.size);
    const request = ++requestRef.current;
    const loadingPreview: FilePreview = {
      entry,
      path: entryPath,
      kind,
      cached: null,
      content: null,
      draft: '',
      editing: false,
      error: null,
      htmlPreview: null,
      filePreview: null,
      htmlRevision: 0,
      gitDiff: null,
      gitStatus: null,
      initialLine: targetLine,
    };
    replacePreview(loadingPreview);
    if (kind === 'unsupported') return;

    let cached: CachedRemoteFile | null = null;
    let htmlPreview: RuntimePreviewInfo | null = null;
    let filePreview: RuntimePreviewInfo | null = null;
    try {
      let content: string | null = null;
      if (isSftpStreamPreview(kind)) {
        filePreview = await client.native.startRemoteFilePreview(entryPath);
      } else {
        cached = await cacheRemoteFile(client, entryPath);
        content = isTextPreview(kind) ? await cached.file.text() : null;
      }
      if (request !== requestRef.current) {
        cached?.dispose();
        if (filePreview) bestEffortCleanup(client.native.stopPreview(filePreview.id), REMOTE_PREVIEW_CLOSE_CONTEXT);
        return;
      }
      if (kind === 'html') htmlPreview = await client.native.startHtmlPreview(entryPath);
      if (request !== requestRef.current) {
        cached?.dispose();
        if (htmlPreview) bestEffortCleanup(client.native.stopPreview(htmlPreview.id), REMOTE_PREVIEW_CLOSE_CONTEXT);
        if (filePreview) bestEffortCleanup(client.native.stopPreview(filePreview.id), REMOTE_PREVIEW_CLOSE_CONTEXT);
        return;
      }
      replacePreview({
        ...loadingPreview,
        cached,
        content,
        draft: content || '',
        htmlPreview,
        filePreview,
      });
      if (kind === 'pdf' && filePreview) await openPdfBrowser(filePreview.url, request);
    } catch (reason) {
      cached?.dispose();
      if (htmlPreview) bestEffortCleanup(client.native.stopPreview(htmlPreview.id), REMOTE_PREVIEW_CLOSE_CONTEXT);
      if (filePreview) bestEffortCleanup(client.native.stopPreview(filePreview.id), REMOTE_PREVIEW_CLOSE_CONTEXT);
      if (request === requestRef.current) {
        replacePreview({ ...loadingPreview, error: String(reason) });
      }
    }
  };

  const openRemotePath = async (remotePath: string, targetLine?: number) => {
    const request = ++requestRef.current;
    const directory = parentRemotePath(remotePath);
    const filename = remotePath.slice(remotePath.lastIndexOf('/') + 1);
    const listing = await client.native.listDirectory(directory);
    if (request !== requestRef.current) return;
    pathRef.current = listing.path;
    setPath(listing.path);
    setEntries(listing.entries);
    onPathChangeRef.current(listing.path);
    const entry = listing.entries.find(candidate => remoteEntryName(candidate) === filename);
    if (!entry) throw new Error(`Remote file not found: ${remotePath}`);
    await openEntry(entry, targetLine);
  };

  const openInitialFile = useEffectEvent(async (remotePath: string, targetLine?: number) => {
    await openRemotePath(remotePath, targetLine);
  });

  useEffect(() => {
    if (!visible || !initialFilePath) return;
    let active = true;
    setBusy(true);
    setError(null);
    openInitialFile(initialFilePath, initialLine).catch(reason => {
      if (active) setError(String(reason));
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [initialFilePath, initialLine, visible]);

  const dismissNow = () => {
    requestRef.current += 1;
    gitRequestRef.current += 1;
    setSortMenuVisible(false);
    replacePreview(null);
    onClose();
  };

  const closePreviewNow = () => {
    requestRef.current += 1;
    replacePreview(null);
  };

  const confirmDiscard = (action: () => void) => {
    const current = previewRef.current;
    if (!current?.editing || current.draft === current.content) {
      action();
      return;
    }
    setDiscardAction(() => action);
  };

  const updatePreview = (updates: Partial<FilePreview>) => {
    const current = previewRef.current;
    if (current) replacePreview({ ...current, ...updates });
  };

  const savePreview = async () => {
    const current = previewRef.current;
    if (!current?.cached || !isTextPreview(current.kind)) return;
    setActionBusy(true);
    try {
      await saveCachedRemoteText(client, current.cached, parentRemotePath(current.path), current.draft);
      updatePreview({
        content: current.draft,
        editing: false,
        htmlRevision: current.htmlRevision + 1,
      });
      Alert.alert(t('files.savedTitle'), t('files.savedCopy', { name: remoteEntryName(current.entry) }));
    } catch (reason) {
      Alert.alert(t('files.saveFailed'), String(reason));
    } finally {
      setActionBusy(false);
    }
  };

  const downloadPreview = async () => {
    const current = previewRef.current;
    if (!current) return;
    setActionBusy(true);
    let cached = current.cached;
    let temporary = false;
    try {
      if (!cached) {
        cached = await cacheRemoteFile(client, current.path);
        temporary = true;
      }
      const destination = await copyCachedRemoteFileToPickedDirectory(cached);
      Alert.alert(
        t('files.downloadedTitle'),
        t('files.downloadedCopy', {
          name: remoteEntryName(current.entry),
          destination,
        }),
      );
    } catch (reason) {
      if (!isPickerCancellation(reason)) Alert.alert(t('files.downloadFailed'), String(reason));
    } finally {
      if (temporary) cached?.dispose();
      setActionBusy(false);
    }
  };

  const uploadFile = async () => {
    setActionBusy(true);
    let picked: Awaited<ReturnType<typeof pickLocalFileForUpload>> = null;
    try {
      picked = await pickLocalFileForUpload();
      if (!picked) return;
      await client.native.startUpload(picked.nativePath, path).result;
      const uploadedName = picked.name;
      await loadDirectory(path);
      Alert.alert(t('files.uploadedTitle'), t('files.uploadedCopy', { name: uploadedName }));
    } catch (reason) {
      Alert.alert(t('files.uploadFailed'), String(reason));
    } finally {
      picked?.dispose();
      setActionBusy(false);
    }
  };

  const deleteEntry = async (entry: RuntimeRemoteFileEntry, directoryPath: string) => {
    const name = remoteEntryName(entry);
    const entryPath = entry.path;
    setDeletingPath(entryPath);
    try {
      await client.native.removeRemotePath(entryPath, entry.kind === 'directory');
      if (pathRef.current === directoryPath) {
        setEntries(current => current.filter(candidate => remoteEntryName(candidate) !== name));
      }
    } catch (reason) {
      Alert.alert(t('files.deleteFailed', { name }), String(reason));
    } finally {
      setDeletingPath(null);
    }
  };

  const confirmDeleteEntry = (entry: RuntimeRemoteFileEntry) => {
    setDeleteTarget({ entry, directoryPath: path });
  };

  const previewLoading = preview && !preview.error && (preview.gitStatus ? !preview.gitDiff : preview.kind !== 'unsupported' && (isSftpStreamPreview(preview.kind) ? !preview.filePreview : !preview.cached));
  const canEdit = preview && !preview.gitStatus && isTextPreview(preview.kind) && Boolean(preview.cached) && preview.content !== null;
  const previewProgressIdentity = preview ? {
    hostId,
    remotePath: preview.path,
    fileSize: preview.entry.size ?? 0,
    modificationDate: preview.entry.modifiedAt?.toString() || '',
  } : null;

  return (
    <Modal animationType="slide" onRequestClose={() => (sortMenuVisible ? setSortMenuVisible(false) : confirmDiscard(preview ? closePreviewNow : dismissNow))} statusBarTranslucent visible={visible}>
      <View
        className="flex-1 bg-background"
        style={{
          paddingTop: safeAreaInsets.top,
          paddingBottom: safeAreaInsets.bottom,
        }}
      >
        {preview ? (
          <>
            <View className="h-14 flex-row items-center border-b border-border bg-background">
              <Button accessibilityLabel={t('files.backToDirectory')} className="h-14 w-11 rounded-none px-0" variant="ghost" onPress={() => confirmDiscard(closePreviewNow)}>
                <ChevronLeft size={21} color={colors.text} />
              </Button>
              <View className="min-w-0 flex-1 px-1">
                <Text numberOfLines={1} className="text-[14px] font-bold text-foreground">
                  {remoteEntryName(preview.entry)}
                </Text>
                <Text numberOfLines={1} className="font-mono text-[8px] text-muted-foreground">
                  {preview.path}
                </Text>
              </View>
              {canEdit &&
                (preview.editing ? (
                  <>
                    <Button
                      accessibilityLabel={t('files.cancelEdit')}
                      className="h-14 w-11 rounded-none px-0"
                      disabled={actionBusy}
                      variant="ghost"
                      onPress={() =>
                        updatePreview({
                          editing: false,
                          draft: preview.content || '',
                        })
                      }
                    >
                      <X size={18} color={colors.textSecondary} />
                    </Button>
                    <Button accessibilityLabel={t('files.save')} className="h-14 w-11 rounded-none px-0" disabled={actionBusy} variant="ghost" onPress={hapticPress(savePreview)}>
                      {actionBusy ? <ActivityIndicator size="small" color={colors.primary} /> : <Check size={19} color={colors.primary} />}
                    </Button>
                  </>
                ) : (
                  <Button accessibilityLabel={t('files.edit')} className="h-14 w-11 rounded-none px-0" disabled={actionBusy} variant="ghost" onPress={hapticPress(() => updatePreview({ editing: true }))}>
                    <Pencil size={17} color={colors.text} />
                  </Button>
                ))}
              {!preview.editing && !preview.gitStatus && (
                <Button accessibilityLabel={t('files.download')} className="h-14 w-11 rounded-none px-0" disabled={actionBusy} variant="ghost" onPress={hapticPress(downloadPreview)}>
                  {actionBusy ? <ActivityIndicator size="small" color={colors.primary} /> : <Download size={18} color={colors.text} />}
                </Button>
              )}
              <Button accessibilityLabel={t('files.close')} className="h-14 w-11 rounded-none px-0" variant="ghost" onPress={() => confirmDiscard(dismissNow)}>
                <X size={19} color={colors.text} />
              </Button>
            </View>
            {preview.gitStatus && gitReviewIndex >= 0 ? (
              <View className="h-12 flex-row items-center border-b border-border px-2">
                <Button accessibilityLabel={t('files.gitPreviousFile')} className="size-11 rounded-full px-0" disabled={gitReviewIndex === 0} variant="ghost" onPress={hapticPress(() => openGitChange(gitReviewFiles[gitReviewIndex - 1]))}>
                  <ChevronLeft size={19} color={colors.text} />
                </Button>
                <Text className="flex-1 text-center text-[12px] text-muted-foreground">
                  {t('files.gitFilePosition', { current: gitReviewIndex + 1, total: gitReviewFiles.length })}
                </Text>
                <Button accessibilityLabel={t('files.gitNextFile')} className="size-11 rounded-full px-0" disabled={gitReviewIndex === gitReviewFiles.length - 1} variant="ghost" onPress={hapticPress(() => openGitChange(gitReviewFiles[gitReviewIndex + 1]))}>
                  <ChevronRight size={19} color={colors.text} />
                </Button>
              </View>
            ) : null}
            {preview.editing ? (
              <CodeEditor editable={!actionBusy} filename={remoteEntryName(preview.entry)} onChangeText={draft => updatePreview({ draft })} progressIdentity={previewProgressIdentity!} value={preview.draft} />
            ) : preview.error ? (
              <FileErrorState
                error={preview.error}
                title={t('files.openFailed')}
                onRetry={() => (preview.gitStatus ? openGitChange(preview.gitStatus) : openEntry(preview.entry, preview.initialLine))}
              />
            ) : previewLoading ? (
              <FileLoadingState label={t('files.opening')} />
            ) : preview.gitStatus && preview.gitDiff ? (
              <RemoteGitDiffPreview
                key={preview.path}
                diff={preview.gitDiff}
                filename={preview.gitStatus.path}
                onLoadContext={context => client.native.gitDiff(gitRepository!, preview.gitStatus!, context)}
                onAskAgent={onAskAgent ? rows => {
                  const selection = formatGitDiffSelection(preview.path, rows);
                  if (!selection) {
                    Alert.alert(t('files.gitSelectionTooLarge'), t('files.gitSelectionTooLargeCopy'));
                    return;
                  }
                  if (!onAskAgent(`${t('files.gitAskPrompt')}\n\n${selection}`)) {
                    Alert.alert(t('files.gitAgentUnavailable'));
                  }
                } : undefined}
                onOpenFile={
                  isRemoteGitEntryDeleted(preview.gitStatus)
                    ? null
                    : () => {
                        openRemotePath(preview.path).catch(reason => {
                          if (previewRef.current === preview) {
                            updatePreview({ error: String(reason) });
                          }
                        });
                      }
                }
              />
            ) : preview.kind === 'unsupported' ? (
              <View className="flex-1 items-center justify-center p-8">
                <FileText size={30} color={colors.textSecondary} />
                <Text className="mt-4 text-center text-[15px] font-semibold">{t('files.previewUnavailable')}</Text>
                <Text className="mt-2 text-center text-[12px] leading-[18px] text-muted-foreground">
                  {t('files.previewUnavailableCopy', {
                    size: formatRemoteFileSize(preview.entry.size ?? -1),
                  })}
                </Text>
              </View>
            ) : preview.kind === 'image' && preview.cached ? (
              <View className="flex-1 bg-terminal-canvas p-3">
                <ZoomableImagePreview accessibilityLabel={remoteEntryName(preview.entry)} uri={preview.cached.uri} />
              </View>
            ) : preview.kind === 'video' && preview.filePreview ? (
              <RemoteVideoPreview filename={remoteEntryName(preview.entry)} progressIdentity={previewProgressIdentity!} uri={preview.filePreview.url} />
            ) : preview.kind === 'audio' && preview.filePreview ? (
              <RemoteAudioPreview filename={remoteEntryName(preview.entry)} progressIdentity={previewProgressIdentity!} uri={preview.filePreview.url} />
            ) : preview.kind === 'pdf' && preview.filePreview ? (
              <View className="flex-1 items-center justify-center p-8">
                <FileText size={34} color={colors.textSecondary} />
                <Text className="mt-4 text-center text-[16px] font-semibold">{t('files.pdfBrowserTitle')}</Text>
                <Text className="mt-2 max-w-[320px] text-center text-[12px] leading-[18px] text-muted-foreground">{t('files.pdfBrowserCopy')}</Text>
                <Button
                  className="mt-5 rounded-full"
                  variant="secondary"
                  onPress={hapticPress(() => {
                    openPdfBrowser(preview.filePreview!.url, requestRef.current).catch(reason => {
                      Alert.alert(t('files.openFailed'), String(reason));
                    });
                  })}
                >
                  <ExternalLink size={16} color={colors.text} />
                  <Text>{t('files.openPdf')}</Text>
                </Button>
              </View>
            ) : preview.kind === 'svg' ? (
              <SvgPreview content={preview.content || ''} filename={remoteEntryName(preview.entry)} />
            ) : preview.kind === 'markdown' ? (
              <MarkdownPreview key={preview.path} client={client} content={preview.content || ''} onOpenRemotePath={openRemotePath} progressIdentity={previewProgressIdentity!} remotePath={preview.path} />
            ) : preview.kind === 'mermaid' ? (
              <MermaidPreview content={preview.content || ''} filename={remoteEntryName(preview.entry)} />
            ) : preview.kind === 'html' && preview.htmlPreview ? (
              <HtmlPreview filename={remoteEntryName(preview.entry)} revision={preview.htmlRevision} uri={preview.htmlPreview.url} />
            ) : preview.kind === 'code' ? (
              <CodePreview content={preview.content || ''} filename={remoteEntryName(preview.entry)} initialLine={preview.initialLine} progressIdentity={previewProgressIdentity!} />
            ) : (
              <RemoteTextPreview content={preview.content || ''} initialLine={preview.initialLine} progressIdentity={previewProgressIdentity!} />
            )}
          </>
        ) : (
          <>
            <View className="h-14 flex-row items-center border-b border-border bg-background px-1">
              <View className="size-11 items-center justify-center">
                <FolderOpen size={20} color={colors.text} />
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-[17px] font-bold text-foreground">{t('files.title')}</Text>
                <Text className="text-[8px] uppercase tracking-[1px] text-muted-foreground">{t(gitMode ? 'files.gitRemote' : 'files.remote')}</Text>
              </View>
              <Button accessibilityLabel={t('files.close')} className="size-11 rounded-full px-0" variant="ghost" onPress={dismissNow}>
                <X size={19} color={colors.text} />
              </Button>
            </View>
            <View className="h-12 flex-row items-center border-b border-border bg-card">
              <Button accessibilityLabel={t('files.parentDirectory')} className="h-12 w-12 rounded-none px-0" disabled={!path || path === '/' || busy || actionBusy} variant="ghost" onPress={hapticPress(() => loadDirectory(parentRemotePath(path)))}>
                <ChevronLeft size={20} color={colors.text} />
              </Button>
              <Text numberOfLines={1} className="min-w-0 flex-1 text-[10px] text-foreground">
                {gitMode ? gitRepository?.root : path || initialPath}
              </Text>
              {gitRepository ? (
                <Button accessibilityLabel={t('files.gitMode')} accessibilityRole="switch" accessibilityState={{ checked: gitMode }} className="h-12 w-12 rounded-none px-0" disabled={busy || actionBusy || gitBusy} variant={gitMode ? 'secondary' : 'ghost'} onPress={hapticPress(toggleGitMode)}>
                  {gitBusy ? <ActivityIndicator size="small" color={colors.primary} /> : <GitCompareArrows size={18} color={gitMode ? colors.primary : colors.text} />}
                </Button>
              ) : null}
              <Button accessibilityLabel={t('files.options')} className="h-12 w-12 rounded-none px-0" disabled={busy || actionBusy} variant="ghost" onPress={hapticPress(() => setSortMenuVisible(true))}>
                <SlidersHorizontal size={18} color={colors.text} />
              </Button>
              <Button accessibilityLabel={t('files.upload')} className="h-12 w-12 rounded-none px-0" disabled={busy || actionBusy || !path} variant="ghost" onPress={hapticPress(uploadFile)}>
                {actionBusy ? <ActivityIndicator size="small" color={colors.primary} /> : <Upload size={18} color={colors.text} />}
              </Button>
              <Button accessibilityLabel={t('files.refresh')} className="h-12 w-12 rounded-none px-0" disabled={busy || actionBusy || gitBusy} variant="ghost" onPress={hapticPress(() => (gitMode ? refreshGitChanges() : loadDirectory(path || initialPath)))}>
                <RefreshCw size={18} color={colors.text} />
              </Button>
            </View>
            {busy ? (
              <FileLoadingState label={t('files.loading')} />
            ) : error ? (
              <FileErrorState
                error={error}
                title={t('files.listFailed')}
                onRetry={() => loadDirectory(path || initialPath)}
              />
            ) : gitMode && gitBusy ? (
              <FileLoadingState label={t('files.gitLoading')} />
            ) : gitMode && gitError ? (
              <FileErrorState
                error={gitError}
                title={t('files.gitFailed')}
                onRetry={refreshGitChanges}
              />
            ) : gitMode && gitTreeRows.length ? (
              <FlatList
                contentContainerStyle={remoteGitListContentStyle}
                data={gitTreeRows}
                initialNumToRender={30}
                keyExtractor={row => row.key}
                maxToRenderPerBatch={40}
                renderItem={({ item: row }) => {
                  const indentStyle = remoteGitTreeIndentStyles[Math.min(row.depth, remoteGitTreeIndentStyles.length - 1)];
                  if (row.kind === 'directory') {
                    const expanded = !gitCollapsedPaths.has(row.path);
                    return (
                      <Button
                        accessibilityLabel={t(expanded ? 'files.gitCollapseFolder' : 'files.gitExpandFolder', { path: row.path })}
                        accessibilityState={{ expanded }}
                        className="h-auto min-h-[52px] justify-start gap-2 rounded-none border-b border-border bg-background py-2 pr-2"
                        style={indentStyle}
                        variant="ghost"
                        onPress={hapticPress(() => toggleGitDirectory(row.path))}
                      >
                        {expanded ? <ChevronDown size={17} color={colors.textSecondary} /> : <ChevronRight size={17} color={colors.textSecondary} />}
                        {expanded ? <FolderOpen size={18} color={colors.primary} /> : <Folder size={18} color={colors.primary} />}
                        <Text numberOfLines={1} className="min-w-0 flex-1 text-left font-mono text-[11px] font-semibold text-foreground">
                          {row.name}
                        </Text>
                        <View className="min-w-7 items-center rounded-full bg-muted px-2 py-1">
                          <Text className="font-mono text-[8px] font-bold text-muted-foreground">{row.changeCount}</Text>
                        </View>
                      </Button>
                    );
                  }
                  const status = row.status;
                  const label = remoteGitStatusLabel(status);
                  const tone = remoteGitStatusColor(status, colors);
                  return (
                    <Button
                      accessibilityLabel={t('files.gitOpenChange', {
                        path: status.path,
                      })}
                      className="h-auto min-h-[58px] justify-start gap-3 rounded-none border-b border-border bg-background py-2 pr-2"
                      style={indentStyle}
                      variant="ghost"
                      onPress={hapticPress(() => openGitChange(status))}
                    >
                      <View className="size-9 items-center justify-center rounded-lg bg-muted">
                        <FileCode2 size={18} color={tone} />
                      </View>
                      <View className="min-w-0 flex-1 items-start">
                        <Text numberOfLines={1} className="text-left font-mono text-[11px] font-semibold text-foreground">
                          {row.name}
                        </Text>
                        <Text numberOfLines={1} className="mt-0.5 font-mono text-[8px] text-muted-foreground">
                          {status.originalPath
                            ? t('files.gitRenamedFrom', {
                                path: status.originalPath,
                              })
                            : status.path}
                        </Text>
                      </View>
                      <View className="min-w-8 items-center rounded-full px-2 py-1" style={{ backgroundColor: colorWithAlpha(tone, '20') }}>
                        <Text className="font-mono text-[9px] font-black" style={{ color: tone }}>
                          {label}
                        </Text>
                      </View>
                      <ChevronRight size={17} color={colors.textTertiary} />
                    </Button>
                  );
                }}
                windowSize={10}
              />
            ) : gitMode && gitStatus.length && !showHiddenFiles ? (
              <HiddenOnlyState onShow={() => updateShowHiddenFiles(true)} />
            ) : gitMode ? (
              <View className="flex-1 items-center justify-center p-8">
                <GitCompareArrows size={30} color={colors.working} />
                <Text className="mt-4 text-[15px] font-semibold text-foreground">{t('files.gitClean')}</Text>
                <Text className="mt-2 text-center text-[12px] leading-[18px] text-muted-foreground">{t('files.gitCleanCopy')}</Text>
              </View>
            ) : sortedEntries.length ? (
              <ScrollView className="flex-1" contentContainerClassName="px-3 py-1">
                {sortedEntries.map(entry => {
                  const name = remoteEntryName(entry);
                  const directory = entry.kind === 'directory';
                  const kind = remotePreviewKind(name, entry.size);
                  return (
                    <SwipeableRemoteFileRow key={entry.path} deleting={deletingPath === entry.path} disabled={Boolean(deletingPath)} name={name} onDelete={() => confirmDeleteEntry(entry)}>
                      {({ actionsOpen, closeActions }) => (
                        <Button
                          accessibilityLabel={t(directory ? 'files.openDirectory' : 'files.openFile', { name })}
                          className="h-auto min-h-[62px] justify-start gap-3 rounded-none bg-background px-2 py-2"
                          disabled={Boolean(deletingPath)}
                          variant="ghost"
                          onPress={hapticPress(() => {
                            if (actionsOpen) closeActions();
                            else reportBackgroundFailure(openEntry(entry), 'remote-entry-open');
                          })}
                        >
                          <View className="size-9 items-center justify-center rounded-lg bg-muted">
                            {directory ? (
                              <Folder size={18} color={colors.primary} />
                            ) : kind === 'image' || kind === 'svg' ? (
                              <ImageIcon size={18} color={colors.textSecondary} />
                            ) : kind === 'video' ? (
                              <FileVideo size={18} color={colors.textSecondary} />
                            ) : kind === 'audio' ? (
                              <FileMusic size={18} color={colors.textSecondary} />
                            ) : kind === 'code' || kind === 'html' || kind === 'mermaid' ? (
                              <FileCode2 size={18} color={colors.textSecondary} />
                            ) : (
                              <FileText size={18} color={colors.textSecondary} />
                            )}
                          </View>
                          <View className="min-w-0 flex-1 items-start">
                            <Text numberOfLines={1} className="text-left text-[13px] font-semibold text-foreground">
                              {name}
                            </Text>
                            <Text numberOfLines={1} className="mt-0.5 text-[8px] text-muted-foreground">
                              {directory ? t('files.directory') : formatRemoteFileSize(entry.size ?? -1)}
                              {formatRemoteModificationDate(entry.modifiedAt) ? ` · ${formatRemoteModificationDate(entry.modifiedAt)}` : ''}
                            </Text>
                          </View>
                          <ChevronRight size={17} color={colors.textTertiary} />
                        </Button>
                      )}
                    </SwipeableRemoteFileRow>
                  );
                })}
              </ScrollView>
            ) : entries.length && !showHiddenFiles ? (
              <HiddenOnlyState onShow={() => updateShowHiddenFiles(true)} />
            ) : (
              <View className="flex-1 items-center justify-center p-8">
                <FolderOpen size={30} color={colors.textSecondary} />
                <Text className="mt-4 text-[15px] font-semibold">{t('files.empty')}</Text>
              </View>
            )}
          </>
        )}
        {sortMenuVisible ? (
          <View className="absolute inset-0 z-50 justify-end">
            <Pressable accessibilityLabel={t('common.close')} className="absolute inset-0 bg-black/55" onPress={() => setSortMenuVisible(false)} />
            <View className="rounded-t-[22px] border-t border-border bg-card px-4 pt-4" style={{ paddingBottom: Math.max(16, safeAreaInsets.bottom) }}>
              <View className="mb-3 flex-row items-center">
                <Text className="min-w-0 flex-1 text-[18px] font-semibold text-foreground">{t('files.optionsTitle')}</Text>
                <Button accessibilityLabel={t('common.close')} className="size-10 rounded-full px-0" variant="ghost" onPress={() => setSortMenuVisible(false)}>
                  <X size={19} color={colors.text} />
                </Button>
              </View>
              <View className="min-h-[68px] flex-row items-center rounded-lg border border-border bg-background px-3.5 py-3">
                <View className="min-w-0 flex-1 pr-4">
                  <Text className="text-[14px] font-semibold text-foreground">{t('files.showHidden')}</Text>
                  <Text className="mt-0.5 text-[10px] leading-[14px] text-muted-foreground">{t('files.showHiddenCopy')}</Text>
                </View>
                <Switch accessibilityLabel={t('files.showHidden')} checked={showHiddenFiles} onCheckedChange={updateShowHiddenFiles} />
              </View>
              {!gitMode ? (
                <>
                  <Text className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-[1px] text-muted-foreground">{t('files.sortBy')}</Text>
                  <View className="overflow-hidden rounded-lg border border-border">
                    {remoteFileSortFields.map((field, index) => {
                      const selected = field === sortField;
                      return (
                        <Button
                          key={field}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          className={index === 0 ? 'min-h-[58px] justify-start rounded-none px-3.5' : 'min-h-[58px] justify-start rounded-none border-t border-border px-3.5'}
                          variant={selected ? 'secondary' : 'ghost'}
                          onPress={hapticPress(() => selectSortField(field))}
                        >
                          <Text className="min-w-0 flex-1 text-left text-sm font-medium">{t(`files.sort.${field}`)}</Text>
                          {selected ? (
                            <View className="items-end">
                              <View className="flex-row items-center gap-1.5">
                                <Text className="text-[11px] font-semibold text-primary">{t(`files.sort.${sortDirection}`)}</Text>
                                {sortDirection === 'ascending' ? <ArrowUp size={16} color={colors.primary} /> : <ArrowDown size={16} color={colors.primary} />}
                              </View>
                              <Text className="mt-0.5 text-[8px] text-muted-foreground">{t('files.sortTapAgain')}</Text>
                            </View>
                          ) : null}
                        </Button>
                      );
                    })}
                  </View>
                </>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
      <ConfirmationPopup
        confirmLabel={t('files.discard')}
        copy={t('files.discardCopy')}
        icon={Trash2}
        title={t('files.discardTitle')}
        visible={discardAction !== null}
        onCancel={() => setDiscardAction(null)}
        onConfirm={() => {
          const action = discardAction;
          setDiscardAction(null);
          action?.();
        }}
      />
      <ConfirmationPopup
        confirmLabel={t('common.delete')}
        copy={t(deleteTarget?.entry.kind === 'directory' ? 'files.deleteDirectoryCopy' : 'files.deleteFileCopy')}
        detail={deleteTarget
          ? deleteTarget.entry.path
          : undefined}
        detailIcon={deleteTarget?.entry.kind === 'directory' ? Folder : FileText}
        icon={Trash2}
        title={t('files.deleteTitle', {
          name: deleteTarget ? remoteEntryName(deleteTarget.entry) : '',
        })}
        visible={deleteTarget !== null}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) {
            reportBackgroundFailure(
              deleteEntry(target.entry, target.directoryPath),
              'remote-entry-delete',
            );
          }
        }}
      />
    </Modal>
  );
}

function FileLoadingState({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View className="flex-1 items-center justify-center gap-3 p-8">
      <ActivityIndicator color={colors.primary} />
      <Text className="text-[12px] text-muted-foreground">{label}</Text>
    </View>
  );
}

function FileErrorState({ title, error, onRetry }: { title: string; error: string; onRetry: () => void | Promise<void> }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center justify-center p-8">
      <Text className="text-center text-[14px] font-semibold text-destructive">{title}</Text>
      <Text className="mt-2 text-center text-[9px] leading-[14px] text-muted-foreground">{error}</Text>
      <Button className="mt-5 rounded-full" variant="secondary" onPress={hapticPress(onRetry)}>
        <RefreshCw size={16} color={colors.text} />
        <Text>{t('files.retry')}</Text>
      </Button>
    </View>
  );
}

function HiddenOnlyState({ onShow }: { onShow: () => void }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center justify-center p-8">
      <FolderOpen size={30} color={colors.textSecondary} />
      <Text className="mt-4 text-center text-[15px] font-semibold text-foreground">{t('files.hiddenOnly')}</Text>
      <Button className="mt-5 rounded-full" variant="secondary" onPress={hapticPress(onShow)}>
        <Text>{t('files.showHiddenAction')}</Text>
      </Button>
    </View>
  );
}

function SwipeableRemoteFileRow({ children, deleting, disabled, name, onDelete }: { children: (controls: { actionsOpen: boolean; closeActions: () => void }) => ReactNode; deleting: boolean; disabled: boolean; name: string; onDelete: () => void }) {
  const { t } = useTranslation();
  const translateX = useSharedValue(0);
  const openRef = useRef(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const actionRevealStyle = useAnimatedStyle(() => ({
    width: Math.max(0, -translateX.value),
  }));

  useEffect(() => () => cancelAnimation(translateX), [translateX]);

  const settle = (open: boolean) => {
    openRef.current = open;
    setActionsOpen(open);
    translateX.value = withSpring(open ? -REMOTE_FILE_SWIPE_ACTION_WIDTH : 0, DEFAULT_SPRING_CONFIG);
  };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_event, gesture) => shouldClaimRemoteFileSwipe(gesture.dx, gesture.dy, openRef.current),
      onPanResponderGrant: () => cancelAnimation(translateX),
      onPanResponderMove: (_event, gesture) => {
        translateX.value = remoteFileSwipeOffset(gesture.dx, openRef.current);
      },
      onPanResponderRelease: (_event, gesture) => {
        settle(shouldOpenRemoteFileSwipe(gesture.dx, gesture.vx, openRef.current));
      },
      onPanResponderTerminate: () => settle(openRef.current),
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;

  const runDelete = () => {
    settle(false);
    onDelete();
  };

  return (
    <View className="relative min-h-[62px] overflow-hidden border-b border-border">
      <Animated.View accessibilityElementsHidden={!actionsOpen} className="absolute inset-y-0 right-0 overflow-hidden" importantForAccessibility={actionsOpen ? 'auto' : 'no-hide-descendants'} style={actionRevealStyle}>
        <Button accessibilityLabel={t('files.deleteEntry', { name })} className="absolute inset-y-0 right-0 h-full w-[84px] flex-col gap-1 rounded-none" disabled={disabled} size="content" variant="destructive" onPress={hapticPress(runDelete)}>
          {deleting ? <ActivityIndicator color="white" size="small" /> : <Icon as={Trash2} className="text-destructive-foreground" size={19} />}
          <Text className="text-[11px] font-semibold">{t('common.delete')}</Text>
        </Button>
      </Animated.View>
      <Animated.View style={animatedStyle} {...panResponder.panHandlers}>
        {children({ actionsOpen, closeActions: () => settle(false) })}
      </Animated.View>
    </View>
  );
}

function isTextPreview(kind: RemotePreviewKind): boolean {
  return kind === 'code' || kind === 'html' || kind === 'markdown' || kind === 'mermaid' || kind === 'svg' || kind === 'text';
}

function isSftpStreamPreview(kind: RemotePreviewKind): boolean {
  return kind === 'audio' || kind === 'pdf' || kind === 'video';
}

function remoteGitStatusEntry(status: RemoteGitStatusEntry): RuntimeRemoteFileEntry {
  return {
    name: status.path.split('/').pop() || status.path,
    path: status.path,
    kind: 'file',
    size: 0,
  };
}

function remoteGitStatusColor(status: RemoteGitStatusEntry, colors: ThemeColors): string {
  const label = remoteGitStatusLabel(status);
  if (label.includes('D')) return colors.error;
  if (label === '??') return colors.warning;
  if (label.includes('A')) return colors.working;
  if (label.includes('R') || label.includes('C')) return colors.primary;
  return colors.warning;
}

function isPickerCancellation(reason: unknown): boolean {
  const message = String(reason).toLowerCase();
  return message.includes('cancel') || message.includes('dismiss');
}

function formatRemoteModificationDate(value: number | undefined): string {
  if (value === undefined) return '';
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}
