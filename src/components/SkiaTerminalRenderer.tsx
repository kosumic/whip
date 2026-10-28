import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SkiaPictureView, matchFont } from '@shopify/react-native-skia';
import { SkiaViewApi } from '@shopify/react-native-skia/src/views/api';
import { createHerdrSurface } from 'react-native-whip-ssh';
import {
  NativeTerminalInput,
  type NativeTerminalInputHandle,
} from './NativeTerminalInput';
import type {
  TerminalRendererHandle,
  TerminalRendererProps,
} from './TerminalRendererHost';
import { surfaceErrorMessage, type SurfaceUpdate } from '../lib/herdrSurface';
import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
} from '../services/performanceTrace';
import { terminalFontFamily } from '../lib/terminalFonts';
import { terminalLineHeight } from '../lib/terminalAppearance';
import { SkiaTerminalSurface } from '../lib/skiaTerminalSurface';
import { useSkiaTerminalFonts } from '../lib/skiaTerminalFonts';

const POLL_MS = 1000 / 30;
const MAX_RECONNECTS = 5;
let nextInputBinding = 0;
const noop = () => {};
type Props = TerminalRendererProps & { onUseXterm: () => void };

export default forwardRef<TerminalRendererHandle, Props>(
  function SkiaTerminalRenderer(props, ref) {
    const target = props.activeTarget!;
    const { fonts, error: fontError } = useSkiaTerminalFonts();
    const input = useRef<NativeTerminalInputHandle | null>(null);
    const view = useRef<SkiaPictureView | null>(null);
    const surface = useRef<ReturnType<typeof createHerdrSurface> | null>(null);
    const connected = useRef(false);
    const connectionFailure = useRef<((reason: unknown) => void) | null>(null);
    const keyboardEnabled = useRef(false);
    const modifiedInput = useRef(false);
    const [inputMounted, setInputMounted] = useState(false);
    const commandSequence = useRef(0);
    const commands = useRef(
      new Map<number, { run: () => void; reject: (error: Error) => void }>(),
    );
    const inputTrace =
      useRef<ReturnType<typeof beginAppPerformanceTrace>>(null);
    const statistics = useRef({
      submittedPictures: 0,
      bridgeBytes: 0,
      drawMs: 0,
      maxDrawMs: 0,
    });
    const current = useRef(props);
    current.current = props;
    const [layout, setLayout] = useState({ width: 0, height: 0 });
    const latestLayout = useRef(layout);
    latestLayout.current = layout;
    const [failure, setFailure] = useState<string | null>(null);
    const [appActive, setAppActive] = useState(
      AppState.currentState === 'active',
    );
    const [attempt, setAttempt] = useState(0);
    const enabled =
      props.visible && props.renderingEnabled !== false && appActive;
    const fontSize = target.session.fontSize ?? props.preferences.fontSize;
    const geometry = useMemo(() => {
      const font = matchFont(
        { fontFamily: terminalFontFamily, fontSize },
        fonts ?? undefined,
      );
      const metrics = font.getMetrics();
      const ratio = PixelRatio.get();
      const cw =
        Math.ceil(
          (font.getGlyphWidths(font.getGlyphIDs('M'))[0] || fontSize * 0.6) *
            ratio,
        ) / ratio;
      const fontHeight = metrics.descent - metrics.ascent;
      const ch = Math.ceil(fontHeight * terminalLineHeight * ratio) / ratio;
      const baseline = -metrics.ascent + (ch - fontHeight) / 2;
      font.dispose();
      return {
        cw,
        ch,
        baseline,
        ratio,
        cols: Math.max(1, Math.min(1024, Math.floor(layout.width / cw))),
        rows: Math.max(
          1,
          Math.min(
            1024,
            Math.floor(
              (layout.height -
                (props.visualViewport?.geometryBottomInset ?? 0)) /
                ch,
            ),
          ),
        ),
        cellWidth: Math.round(cw * ratio),
        cellHeight: Math.round(ch * ratio),
      };
    }, [fonts, fontSize, layout.width, layout.height, props.visualViewport]);
    const latestGeometry = useRef(geometry);
    latestGeometry.current = geometry;
    const binding = useMemo(
      () =>
        `${target.key}:skia-${Date.now().toString(36)}-${++nextInputBinding}`,
      // A replacement native runtime must retire keyboard edits even for the same pane key.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [target.key, target.client],
    );

    const reportError = (reason: unknown) => {
      console.error('[Whip Skia input]', surfaceErrorMessage(reason));
      // Typing during attach/backoff must not cancel that pending connection.
      if (!connected.current) setFailure(surfaceErrorMessage(reason));
      else connectionFailure.current?.(reason);
    };
    const send = (text: string, paste: boolean) => {
      if (!connected.current || !surface.current)
        throw new Error('Herdr surface is not connected');
      surface.current.input(text, paste);
      inputTrace.current ??= beginAppPerformanceTrace(
        'Whip Skia input to next picture submitted',
      );
    };
    const nativeSend = (text: string) => {
      Promise.resolve(current.current.onInput(target, text)).catch(reportError);
    };
    // Flush pending native IME edits before rail keys, composer submissions, or pastes.
    const afterNativeInput = (operation: () => void | Promise<void>) =>
      new Promise<void>((resolve, reject) => {
        if (!input.current || !inputMounted || !enabled) {
          reject(new Error('Terminal input view is unavailable'));
          return;
        }
        const id = ++commandSequence.current;
        commands.current.set(id, {
          reject,
          run: () => {
            try {
              Promise.resolve(operation()).then(resolve, reject);
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        });
        input.current.barrier(binding, id);
      });
    useEffect(
      () => () => {
        for (const command of commands.current.values())
          command.reject(new Error('Terminal input view detached'));
        commands.current.clear();
      },
      [binding, enabled],
    );
    useImperativeHandle(ref, () => ({
      blur: () => {
        if (inputMounted) input.current?.blur();
      },
      focus: () => {
        if (inputMounted && enabled) input.current?.focus();
      },
      setKeyboardEnabled: value => {
        keyboardEnabled.current = value;
        if (inputMounted) input.current?.setEnabled(value && enabled);
      },
      setInputModifiers: value => {
        modifiedInput.current = value;
        if (inputMounted) input.current?.modifiedInput(value);
      },
      input: text => {
        void afterNativeInput(() => nativeSend(text)).catch(reportError);
        return true;
      },
      writeEndpointInput: text => {
        try {
          send(text, false);
        } catch (e) {
          reportError(e);
        }
        return true;
      },
      paste: text => {
        void afterNativeInput(() => send(text, true)).catch(reportError);
      },
      submitPastes: (destination, parts) =>
        afterNativeInput(() => {
          if (destination.key !== target.key)
            throw new Error('Skia supports only the active pane');
          for (let i = 0; i < parts.length; i++) {
            if (i > 0) send(' ', false);
            send(parts[i], true);
          }
          send('\r', false);
        }),
      retry: () => {
        setFailure(null);
        setAttempt(v => v + 1);
      },
      fit: noop,
      cancelPendingResumeScroll: noop,
      clearSearch: noop,
      scanLinks: noop,
      scroll: noop,
      scrollToVisualBottom: noop,
      search: noop,
      readContext: () => Promise.resolve(''),
      changeFontSize: delta =>
        current.current.onFontSizeChange(
          target,
          Math.max(4, Math.min(32, fontSize + delta)),
        ),
    }));
    useEffect(() => {
      const subscription = AppState.addEventListener('change', state =>
        setAppActive(state === 'active'),
      );
      return () => subscription.remove();
    }, []);

    const hasLayout = layout.width > 0 && layout.height > 0;
    useEffect(() => {
      // Expo's Fabric view registry is populated after native mount, not at the JS ref callback.
      if (!inputMounted) return;
      input.current?.setEnabled(keyboardEnabled.current && enabled);
      input.current?.modifiedInput(modifiedInput.current);
    }, [enabled, inputMounted]);
    useEffect(() => {
      if (!enabled || !hasLayout || !fonts) return;
      let cancelled = false;
      let frame = 0;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let lastPoll = 0;
      let reconnects = 0;
      const pixels = new SkiaTerminalSurface(
        fonts,
        fontSize,
        latestGeometry.current,
      );
      const stats = statistics.current;
      let trace = beginAppPerformanceTrace(
        'Whip Skia attach to first picture submitted',
      );
      let first = true;
      const channel = createHerdrSurface(
        target.client.native.runtimeId,
        target.session.paneId,
      );
      surface.current = channel;
      const draw = (update: SurfaceUpdate, bridgeCodeUnits: number) => {
        const drawStarted = performance.now();
        const before = { ...pixels.counters };
        const picture = pixels.update(update, latestLayout.current);
        if (!picture) return;
        if (view.current) {
          SkiaViewApi.setJsiProperty(view.current.nativeId, 'picture', picture);
          view.current.redraw();
        }
        picture.dispose();
        const { ch } = latestGeometry.current;
        const cursor = update.cursor;
        current.current.onCursorGeometry?.(
          target,
          cursor?.visible ? (cursor.y + 1) * ch : null,
          latestLayout.current.height,
        );
        const elapsed = performance.now() - drawStarted;
        const observe = current.current.onFrameMetrics;
        if (observe) {
          observe({
            renderer: 'skia',
            phase: 'prepared',
            timestampMs: Date.now(),
            prepareMs: elapsed,
            bridgeCodeUnits,
            paintedCells: pixels.counters.paintedCells - before.paintedCells,
            shapedGlyphs: pixels.counters.shapedGlyphs - before.shapedGlyphs,
            cacheHits: pixels.counters.cacheHits - before.cacheHits,
            columns: update.width,
            rows: update.height,
            cellWidthPx: latestGeometry.current.cellWidth,
            cellHeightPx: latestGeometry.current.cellHeight,
          });
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (!cancelled)
                current.current.onFrameMetrics?.({
                  renderer: 'skia',
                  phase: 'presented-proxy',
                  timestampMs: Date.now(),
                });
            }),
          );
        }
        statistics.current.submittedPictures++;
        statistics.current.drawMs += elapsed;
        statistics.current.maxDrawMs = Math.max(
          statistics.current.maxDrawMs,
          elapsed,
        );
        endAppPerformanceTrace(inputTrace.current);
        inputTrace.current = null;
        if (first) {
          first = false;
          endAppPerformanceTrace(trace);
          trace = null;
          current.current.onStatus(target, 'connected', undefined, 0);
          current.current.onVisualScrollState(target, true);
          current.current.onReady?.();
          current.current.onProtocolStateChange(target, {
            kittyKeyboardReportAll: false,
          });
        }
      };
      const start = async () => {
        try {
          first = true;
          current.current.onStatus(target, 'connecting', undefined, reconnects);
          trace ??= beginAppPerformanceTrace(
            'Whip Skia attach to first picture submitted',
          );
          const g = latestGeometry.current;
          await channel.connect(g.cols, g.rows, g.cellWidth, g.cellHeight);
          if (cancelled) return;
          connected.current = true;
          reconnects = 0;
          setFailure(null);
          const latest = latestGeometry.current;
          channel.resize(
            latest.cols,
            latest.rows,
            latest.cellWidth,
            latest.cellHeight,
          );
        } catch (e) {
          failed(e);
        }
      };
      const failed = (reason: unknown) => {
        if (cancelled) return;
        console.error(
          '[Whip Skia renderer]',
          reason instanceof Error ? reason.stack : String(reason),
        );
        connected.current = false;
        const message = surfaceErrorMessage(reason);
        setFailure(previous => previous ?? message);
        current.current.onStatus(target, 'error', message, reconnects);
        channel.close();
        clearTimeout(retryTimer);
        // Retry transport failures only. Protocol/geometry failures need explicit user action.
        if (
          /SSH|disconnect|closed|EOF|transport|timed out|Unix.socket|connection was replaced/i.test(
            message,
          ) &&
          reconnects < MAX_RECONNECTS
        ) {
          retryTimer = setTimeout(
            () => {
              void start();
            },
            Math.min(8000, 500 * 2 ** reconnects++),
          );
        }
      };
      connectionFailure.current = failed;
      const tick = (time: number) => {
        if (cancelled) return;
        if (connected.current && time - lastPoll >= POLL_MS) {
          lastPoll = time;
          try {
            const update = channel.takeUpdate();
            if (update) {
              statistics.current.bridgeBytes += update.length;
              draw(JSON.parse(update) as SurfaceUpdate, update.length);
            }
          } catch (e) {
            failed(e);
          }
        }
        frame = requestAnimationFrame(tick);
      };
      void start();
      frame = requestAnimationFrame(tick);
      return () => {
        cancelled = true;
        if (connectionFailure.current === failed)
          connectionFailure.current = null;
        connected.current = false;
        cancelAnimationFrame(frame);
        clearTimeout(retryTimer);
        endAppPerformanceTrace(trace);
        endAppPerformanceTrace(inputTrace.current);
        inputTrace.current = null;
        console.info('[Whip Skia metrics]', {
          ...stats,
          native: channel.metrics(),
          platform: Platform.OS,
          pixelRatio: PixelRatio.get(),
        });
        channel.close();
        surface.current = null;
        pixels.dispose();
      };
      // Geometry updates resize the existing connection rather than reattaching.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      target.key,
      target.client,
      enabled,
      hasLayout,
      attempt,
      fontSize,
      fonts,
    ]);
    useEffect(() => {
      if (!connected.current) return;
      try {
        surface.current?.resize(
          geometry.cols,
          geometry.rows,
          geometry.cellWidth,
          geometry.cellHeight,
        );
      } catch (e) {
        reportError(e);
      }
    }, [geometry]);

    return (
      <View
        testID="herdr-skia-terminal"
        style={[styles.host, props.style]}
        onLayout={event => setLayout(event.nativeEvent.layout)}
      >
        <Pressable
          style={styles.host}
          onPress={() => {
            if (inputMounted && enabled) input.current?.focus();
          }}
        >
          <SkiaPictureView ref={view} style={styles.host} opaque={false} />
        </Pressable>
        <NativeTerminalInput
          ref={input}
          binding={binding}
          onLayout={() => setInputMounted(true)}
          onCommandError={reportError}
          onTerminalInput={event => {
            const {
              binding: eventBinding,
              data,
              commandId,
            } = event.nativeEvent;
            if (eventBinding !== binding) return;
            if (typeof commandId === 'number') {
              const command = commands.current.get(commandId);
              commands.current.delete(commandId);
              command?.run();
            } else if (enabled && keyboardEnabled.current && data) {
              nativeSend(data);
            }
          }}
        />
        {(failure || fontError) && (
          <View style={styles.failure}>
            <Text style={styles.text}>{failure || fontError}</Text>
            <Pressable
              onPress={() => {
                setFailure(null);
                setAttempt(v => v + 1);
              }}
            >
              <Text style={styles.action}>Retry Skia</Text>
            </Pressable>
            <Pressable onPress={props.onUseXterm}>
              <Text style={styles.action}>Use xterm.js</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  },
);
const styles = StyleSheet.create({
  host: { flex: 1, backgroundColor: 'transparent' },
  failure: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    backgroundColor: '#16161e',
  },
  text: { color: '#ffb4a9' },
  action: { color: '#9ccfff', paddingVertical: 12 },
});
