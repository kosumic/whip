import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { BackHandler } from 'react-native';

import {
  handleMobileBack,
  initialMobileNavigation,
  selectMobileTab,
  type MobileNavigationState,
} from '../mobileNavigation';
import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
  type AppPerformanceTrace,
} from '../services/performanceTrace';
import type { AppTab } from '../types';

interface AppNavigationOptions {
  appReady: boolean;
  preferencesLoaded: boolean;
  preferredTab: AppTab;
  recordLastTab: (tab: AppTab) => void;
  dismissTopOverlay: () => boolean;
  onFirstTabMounted?: () => void;
}

interface NavigationViewState {
  state: MobileNavigationState;
  herdHostFilterId: string | null;
  herdWorkspaceFilterIds: Record<string, string | null>;
  selectedPaneId: string | null;
  licensesOpen: boolean;
}

type NavigationAction =
  | { type: 'tab-selected'; tab: AppTab }
  | { type: 'pane-selected'; paneId: string | null }
  | { type: 'herd-host-selected'; sessionId: string | null }
  | { type: 'workspace-selected'; sessionId: string; workspaceId: string | null }
  | { type: 'terminal-shown' }
  | { type: 'herd-shown'; sessionId?: string; workspaceId?: string | null }
  | { type: 'session-cleared'; sessionId: string }
  | { type: 'licenses-changed'; open: boolean }
  | { type: 'back' };

const INITIAL_NAVIGATION: NavigationViewState = {
  state: initialMobileNavigation,
  herdHostFilterId: null,
  herdWorkspaceFilterIds: {},
  selectedPaneId: null,
  licensesOpen: false,
};

function navigationReducer(current: NavigationViewState, action: NavigationAction): NavigationViewState {
  switch (action.type) {
    case 'tab-selected':
      return { ...current, state: selectMobileTab(current.state, action.tab) };
    case 'pane-selected':
      return { ...current, selectedPaneId: action.paneId };
    case 'herd-host-selected':
      return { ...current, herdHostFilterId: action.sessionId };
    case 'workspace-selected':
      return current.herdWorkspaceFilterIds[action.sessionId] === action.workspaceId ? current : {
        ...current,
        herdWorkspaceFilterIds: { ...current.herdWorkspaceFilterIds, [action.sessionId]: action.workspaceId },
      };
    case 'terminal-shown':
      return { ...current, state: selectMobileTab(current.state, 'terminal'), selectedPaneId: null };
    case 'herd-shown':
      return {
        ...current,
        state: selectMobileTab(current.state, 'herd'),
        herdHostFilterId: action.sessionId || current.herdHostFilterId,
        herdWorkspaceFilterIds: action.sessionId && action.workspaceId
          ? { ...current.herdWorkspaceFilterIds, [action.sessionId]: action.workspaceId }
          : current.herdWorkspaceFilterIds,
      };
    case 'session-cleared': {
      const filters = { ...current.herdWorkspaceFilterIds };
      delete filters[action.sessionId];
      return {
        ...current,
        selectedPaneId: null,
        herdHostFilterId: current.herdHostFilterId === action.sessionId ? null : current.herdHostFilterId,
        herdWorkspaceFilterIds: filters,
      };
    }
    case 'licenses-changed':
      return { ...current, licensesOpen: action.open };
    case 'back':
      if (current.licensesOpen) return { ...current, licensesOpen: false };
      if (current.selectedPaneId) return { ...current, selectedPaneId: null };
      return { ...current, state: handleMobileBack(current.state).state };
  }
}

export interface AppNavigationController {
  state: MobileNavigationState;
  mountedTabs: ReadonlySet<AppTab>;
  herdHostFilterId: string | null;
  herdWorkspaceFilterIds: Readonly<Record<string, string | null>>;
  selectedPaneId: string | null;
  licensesOpen: boolean;
  selectTab: (tab: AppTab) => void;
  selectPane: (paneId: string | null) => void;
  selectHerdHost: (sessionId: string | null) => void;
  setHerdWorkspaceFilter: (
    sessionId: string,
    workspaceId: string | null,
  ) => void;
  showTerminal: (sessionId?: string) => void;
  showHerd: (sessionId?: string, workspaceId?: string | null) => void;
  clearSessionView: (sessionId: string) => void;
  openLicenses: () => void;
  closeLicenses: () => void;
}

/** Owns application tab policy, mounted-tab retention, view filters, and Android back. */
export function useAppNavigation({
  appReady,
  preferencesLoaded,
  preferredTab,
  recordLastTab,
  dismissTopOverlay,
  onFirstTabMounted,
}: AppNavigationOptions): AppNavigationController {
  const [{ state, herdHostFilterId, herdWorkspaceFilterIds, selectedPaneId, licensesOpen }, dispatch] =
    useReducer(navigationReducer, INITIAL_NAVIGATION);
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<AppTab>>(
    () => new Set(),
  );
  const hydratedRef = useRef(false);
  const firstTabMountedNotifiedRef = useRef(false);
  const startupTraceRef = useRef<AppPerformanceTrace | null>(null);
  const tabMountTracesRef = useRef(new Map<AppTab, AppPerformanceTrace>());
  const dismissOverlay = useEffectEvent(dismissTopOverlay);
  const notifyFirstTabMounted = useEffectEvent(() => onFirstTabMounted?.());

  useEffect(() => {
    const tabMountTraces = tabMountTracesRef.current;
    startupTraceRef.current = beginAppPerformanceTrace(
      'Whip startup to first tab',
    );
    return () => {
      endAppPerformanceTrace(startupTraceRef.current);
      for (const trace of tabMountTraces.values()) {
        endAppPerformanceTrace(trace);
      }
      tabMountTraces.clear();
    };
  }, []);

  useEffect(() => {
    if (!preferencesLoaded || hydratedRef.current) return;
    hydratedRef.current = true;
    dispatch({ type: 'tab-selected', tab: preferredTab === 'terminal' ? 'hosts' : preferredTab });
  }, [preferencesLoaded, preferredTab]);

  useEffect(() => {
    if (!appReady || mountedTabs.has(state.tab)) return;
    const tab = state.tab;
    const trace = beginAppPerformanceTrace(`Whip first tab mount: ${tab}`);
    if (trace) tabMountTracesRef.current.set(tab, trace);
    setMountedTabs(current => {
      if (current.has(tab)) return current;
      const next = new Set(current);
      next.add(tab);
      return next;
    });
  }, [appReady, mountedTabs, state.tab]);

  useEffect(() => {
    for (const [tab, trace] of tabMountTracesRef.current) {
      if (!mountedTabs.has(tab)) continue;
      endAppPerformanceTrace(trace);
      tabMountTracesRef.current.delete(tab);
    }
    if (mountedTabs.size === 0 || firstTabMountedNotifiedRef.current) return;
    firstTabMountedNotifiedRef.current = true;
    endAppPerformanceTrace(startupTraceRef.current);
    startupTraceRef.current = null;
    notifyFirstTabMounted();
  }, [mountedTabs]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    recordLastTab(state.tab);
  }, [recordLastTab, state.tab]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (licensesOpen) {
          dispatch({ type: 'back' });
          return true;
        }
        if (dismissOverlay()) return true;
        if (selectedPaneId) {
          dispatch({ type: 'back' });
          return true;
        }
        const result = handleMobileBack(state);
        if (result.handled) dispatch({ type: 'back' });
        return result.handled;
      },
    );
    return () => subscription.remove();
  }, [licensesOpen, selectedPaneId, state]);

  const selectTab = useCallback((tab: AppTab) => {
    dispatch({ type: 'tab-selected', tab });
  }, []);

  const setHerdWorkspaceFilter = useCallback(
    (sessionId: string, workspaceId: string | null) => {
      dispatch({ type: 'workspace-selected', sessionId, workspaceId });
    },
    [],
  );

  const showTerminal = useCallback((_sessionId?: string) => {
    dispatch({ type: 'terminal-shown' });
  }, []);

  const showHerd = useCallback(
    (sessionId?: string, workspaceId?: string | null) => {
      dispatch({ type: 'herd-shown', sessionId, workspaceId });
    },
    [],
  );

  const clearSessionView = useCallback((sessionId: string) => {
    dispatch({ type: 'session-cleared', sessionId });
  }, []);
  const selectPane = useCallback((paneId: string | null) => dispatch({ type: 'pane-selected', paneId }), []);
  const selectHerdHost = useCallback((sessionId: string | null) => dispatch({ type: 'herd-host-selected', sessionId }), []);
  const openLicenses = useCallback(() => dispatch({ type: 'licenses-changed', open: true }), []);
  const closeLicenses = useCallback(() => dispatch({ type: 'licenses-changed', open: false }), []);

  return useMemo(
    () => ({
      state,
      mountedTabs,
      herdHostFilterId,
      herdWorkspaceFilterIds,
      selectedPaneId,
      licensesOpen,
      selectTab,
      selectPane,
      selectHerdHost,
      setHerdWorkspaceFilter,
      showTerminal,
      showHerd,
      clearSessionView,
      openLicenses,
      closeLicenses,
    }),
    [
      clearSessionView,
      closeLicenses,
      herdHostFilterId,
      herdWorkspaceFilterIds,
      licensesOpen,
      mountedTabs,
      openLicenses,
      selectTab,
      selectPane,
      selectHerdHost,
      selectedPaneId,
      setHerdWorkspaceFilter,
      showHerd,
      showTerminal,
      state,
    ],
  );
}
