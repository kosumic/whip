import type { EditorView } from '@codemirror/view';

// A regular filter also works in WebViews that silently skip backdrop-filter.
// Copy only CodeMirror's rendered viewport, retaining its folds and syntax colors.
export function createCodeGlass(getEditor: () => EditorView | null) {
  const backdrop = document.getElementById('code-blur')!;
  let frame = 0;
  let dirty = true;
  let copy: HTMLElement | null = null;
  function refresh() {
    if (!frame) frame = requestAnimationFrame(draw);
  }
  function draw() {
    frame = 0;
    const view = getEditor();
    backdrop.hidden = !view || document.documentElement.dataset.glass !== 'true';
    if (backdrop.hidden || !view) {
      backdrop.replaceChildren(); copy = null; dirty = true;
      return;
    }
    if (dirty || !copy) {
      copy = view.dom.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.cm-tooltip, .cm-announced').forEach(element => element.remove());
      copy.querySelectorAll('[contenteditable]').forEach(element => element.setAttribute('contenteditable', 'false'));
      backdrop.replaceChildren(copy);
      dirty = false;
    }
    const scroller = copy.querySelector<HTMLElement>('.cm-scroller');
    if (scroller) {
      scroller.scrollTop = view.scrollDOM.scrollTop;
      scroller.scrollLeft = view.scrollDOM.scrollLeft;
    }
  }
  function attach(view: EditorView) {
    dirty = true;
    const observer = new MutationObserver(() => { dirty = true; refresh(); });
    observer.observe(view.dom, { childList: true, subtree: true, attributes: true, characterData: true });
    view.scrollDOM.addEventListener('scroll', refresh, { passive: true });
    refresh();
    return () => {
      observer.disconnect();
      view.scrollDOM.removeEventListener('scroll', refresh);
      cancelAnimationFrame(frame); frame = 0;
      backdrop.replaceChildren(); copy = null;
    };
  }
  return { refresh, attach };
}
