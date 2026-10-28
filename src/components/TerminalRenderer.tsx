import {
  Component,
  Suspense,
  forwardRef,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Text, View, Pressable } from 'react-native';
import {
  TerminalRendererHost as XtermRenderer,
  type TerminalRendererHandle,
  type TerminalRendererProps,
} from './TerminalRendererHost';
import { isSkiaHerdrRenderer } from '../lib/herdrSurface';
import { TerminalResidencyEndReason } from '../lib/terminalResidency';

export type { TerminalRendererHandle } from './TerminalRendererHost';
// Defer native module initialization until the flag selects Skia. A synchronous
// require inside the promise also works in the offline Jest runtime.
const SkiaTerminalRenderer = lazy(() =>
  Promise.resolve(
    require('./SkiaTerminalRenderer') as typeof import('./SkiaTerminalRenderer'),
  ),
);

class RendererBoundary extends Component<
  { children: ReactNode; fallback: (message: string) => ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: String(error) };
  }
  render() {
    return this.state.error
      ? this.props.fallback(this.state.error)
      : this.props.children;
  }
}

export const TerminalRendererHost = forwardRef<
  TerminalRendererHandle,
  TerminalRendererProps
>(function Renderer(props, ref) {
  const [fallback, setFallback] = useState<string | null>(null);
  useEffect(() => {
    if (props.preferences.herdrRenderer !== 'skia') setFallback(null);
  }, [props.preferences.herdrRenderer]);
  const eligible = isSkiaHerdrRenderer(
    props.preferences.herdrRenderer,
    props.activeTarget?.session.kind,
    props.activeTarget?.session.paneId,
  );
  const swappingRenderer = eligible && fallback !== props.activeTarget?.key;
  const residency = useRef({
    swappingRenderer,
    callback: props.onResidencyEnd,
  });
  residency.current = { swappingRenderer, callback: props.onResidencyEnd };
  const onResidencyEnd = useCallback<
    NonNullable<TerminalRendererProps['onResidencyEnd']>
  >((target, reason) => {
    // A presentation switch must not close the pane's independently owned chat transcript.
    if (
      residency.current.swappingRenderer &&
      reason === TerminalResidencyEndReason.Evicted
    )
      return;
    residency.current.callback?.(target, reason);
  }, []);
  if (!eligible || fallback === props.activeTarget?.key)
    return (
      <XtermRenderer {...props} ref={ref} onResidencyEnd={onResidencyEnd} />
    );
  const useXterm = () => setFallback(props.activeTarget?.key ?? null);
  const failure = (message: string) => (
    <View style={{ flex: 1, padding: 16, backgroundColor: '#16161e' }}>
      <Text style={{ color: '#ffb4a9' }}>
        Experimental Herdr renderer failed: {message}
      </Text>
      <Pressable onPress={useXterm}>
        <Text style={{ color: '#9ccfff', paddingVertical: 16 }}>
          Use xterm.js
        </Text>
      </Pressable>
    </View>
  );
  return (
    <RendererBoundary key={props.activeTarget?.key} fallback={failure}>
      <Suspense fallback={<View style={{ flex: 1 }} />}>
        <SkiaTerminalRenderer {...props} ref={ref} onUseXterm={useXterm} />
      </Suspense>
    </RendererBoundary>
  );
});
