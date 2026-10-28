import type { EditorView } from '@codemirror/view';

const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.1;
interface Anchor { position: number; x: number; y: number }

export function createCodeZoom(getEditor: () => EditorView | null, onChange: () => void) {
  let scale = 1;
  let baseFontSize = 12;
  let anchorFrame = 0;
  function anchorAt(x: number, y: number): Anchor | undefined {
    const view = getEditor();
    const position = view?.posAtCoords({ x, y });
    if (position == null || !view) return;
    const coordinates = view.coordsAtPos(position);
    return coordinates ? { position, x: coordinates.left, y: coordinates.top } : undefined;
  }
  function applySize() {
    document.documentElement.style.setProperty('--code-font-size', `${baseFontSize * scale}px`);
  }
  function setScale(next: number, anchor?: Anchor) {
    next = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next)) * 1000) / 1000;
    if (next === scale) return;
    const view = getEditor();
    if (!anchor && view) {
      const bounds = view.scrollDOM.getBoundingClientRect();
      anchor = anchorAt((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
    }
    scale = next;
    applySize();
    cancelAnimationFrame(anchorFrame);
    view?.requestMeasure({
      key: 'code-zoom',
      read: () => undefined,
      write: (_, current) => {
        // CodeMirror adjusts its own scroll anchor after measurement callbacks.
        // Correct the pinch focal point once that layout pass has finished.
        anchorFrame = requestAnimationFrame(() => {
          anchorFrame = 0;
          if (!anchor || getEditor() !== current) return;
          const coordinates = current.coordsAtPos(anchor.position);
          if (!coordinates) return;
          current.scrollDOM.scrollLeft += coordinates.left - anchor.x;
          current.scrollDOM.scrollTop += coordinates.top - anchor.y;
        });
      },
    });
    onChange();
  }
  function attach(view: EditorView) {
    const scroller = view.scrollDOM;
    let previousState = view.state;
    let gesture: { distance: number; scale: number; anchor?: Anchor; centerX: number; centerY: number } | undefined;
    let pinching = false;
    const center = (event: TouchEvent) => ({
      x: (event.touches[0].clientX + event.touches[1].clientX) / 2,
      y: (event.touches[0].clientY + event.touches[1].clientY) / 2,
      distance: Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY),
    });
    const consume = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
    const start = (event: TouchEvent) => {
      if (event.touches.length === 1 && !pinching) previousState = view.state;
      if (event.touches.length !== 2) return;
      const point = center(event);
      if (!point.distance) return;
      consume(event);
      pinching = true;
      gesture = { distance: point.distance, scale, anchor: anchorAt(point.x, point.y), centerX: point.x, centerY: point.y };
      if (previousState.doc === view.state.doc && !view.state.selection.eq(previousState.selection)) view.dispatch({ selection: previousState.selection });
    };
    const move = (event: TouchEvent) => {
      if (!pinching) return;
      consume(event);
      if (!gesture || event.touches.length !== 2) return;
      const point = center(event);
      const anchor = gesture.anchor && {
        position: gesture.anchor.position,
        x: gesture.anchor.x + point.x - gesture.centerX,
        y: gesture.anchor.y + point.y - gesture.centerY,
      };
      setScale(gesture.scale * point.distance / gesture.distance, anchor);
    };
    const end = (event: TouchEvent) => {
      if (!pinching) return;
      consume(event);
      gesture = undefined;
      if (event.touches.length === 0 || event.type === 'touchcancel') pinching = false;
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      consume(event);
      setScale(scale * Math.exp(-event.deltaY * 0.005), anchorAt(event.clientX, event.clientY));
    };
    const listenerOptions = { passive: false, capture: true } as const;
    scroller.addEventListener('touchstart', start, listenerOptions);
    scroller.addEventListener('touchmove', move, listenerOptions);
    scroller.addEventListener('touchend', end, listenerOptions);
    scroller.addEventListener('touchcancel', end, listenerOptions);
    scroller.addEventListener('wheel', wheel, listenerOptions);
    return () => {
      cancelAnimationFrame(anchorFrame);
      scroller.removeEventListener('touchstart', start, true);
      scroller.removeEventListener('touchmove', move, true);
      scroller.removeEventListener('touchend', end, true);
      scroller.removeEventListener('touchcancel', end, true);
      scroller.removeEventListener('wheel', wheel, true);
    };
  }
  return {
    get scale() { return scale; },
    configure(fontSize: number) { baseFontSize = fontSize; applySize(); },
    setScale,
    step(direction: number) { setScale(scale + direction * ZOOM_STEP); },
    attach,
  };
}
