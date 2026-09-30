// Fixed semantic DOM program; this exposes no native capability to the page.
const DOM_RUNTIME = String.raw`"use strict";
/** Runs in the page, with no native capability or message listener. */
function domRuntime(key, action, args, identity) {
    const root = window;
    let state = root[key];
    if (!state) {
        state = { identity, revision: 0, sequence: 0, refs: new Map(), snapshot: -1, changedAt: Date.now() };
        const changed = () => { state.revision++; state.changedAt = Date.now(); };
        state.observer = new MutationObserver(changed);
        state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        addEventListener('input', changed, true);
        addEventListener('change', changed, true);
        addEventListener('popstate', changed, true);
        addEventListener('hashchange', changed, true);
        root[key] = state;
    }
    if (state.identity !== identity) {
        state.identity = identity;
        state.revision++;
        state.refs.clear();
        state.snapshot = -1;
    }
    if (state.observer.takeRecords().length) {
        state.revision++;
        state.changedAt = Date.now();
    }
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
            rect.top < innerHeight && rect.left < innerWidth && style.display !== 'none' &&
            style.visibility !== 'hidden' && style.opacity !== '0' && !el.closest('[inert],[aria-hidden="true"]');
    };
    const url = new URL(location.href);
    const page = { url: url.protocol === 'about:' ? 'about:blank' : url.origin + url.pathname, title: clean(document.title), generation: state.identity + ':' + state.revision };
    const role = (el) => el.getAttribute('role') || {
        A: 'link', BUTTON: 'button', INPUT: ['checkbox', 'radio'].includes(el.type) ? el.type : 'textbox',
        TEXTAREA: 'textbox', SELECT: 'combobox', H1: 'heading', H2: 'heading', H3: 'heading', SUMMARY: 'button',
    }[el.tagName] || (el.hasAttribute('contenteditable') ? 'textbox' : 'text');
    const name = (el) => {
        const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
        const labels = el.labels;
        // Never inspect value, title attributes, URLs, cookies, or hidden DOM.
        return clean(el.getAttribute('aria-label') || labelled || (labels ? Array.from(labels).map(label => label.textContent).join(' ') : '') ||
            el.getAttribute('placeholder') || (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ? '' : el.textContent));
    };
    if (action === 'snapshot') {
        state.refs.clear();
        state.sequence++;
        state.snapshot = state.revision;
        const elements = [];
        const selector = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,h1,h2,h3,[role],[contenteditable="true"],[tabindex="0"]';
        for (const el of Array.from(document.querySelectorAll(selector))) {
            if (!visible(el))
                continue;
            const ref = state.identity + ':' + state.sequence + ':e' + (elements.length + 1);
            state.refs.set(ref, el);
            const item = { ref, role: role(el), name: name(el) };
            if (el.disabled || el.getAttribute('aria-disabled') === 'true')
                item.disabled = true;
            if (el.type === 'password')
                item.sensitive = true;
            elements.push(item);
            if (elements.length === 200)
                break;
        }
        return { ...page, elements };
    }
    if (action === 'wait_for_dom') {
        return { ...page, ready: args.selector ? Array.from(document.querySelectorAll(String(args.selector))).some(visible) : Date.now() - state.changedAt >= 300 };
    }
    if (action === 'scroll') {
        scrollBy({ left: Number(args.x || 0), top: Number(args.y), behavior: 'instant' });
        state.revision++;
        state.changedAt = Date.now();
        return { ...page, scrolled: true };
    }
    if (action === 'click' || action === 'type') {
        const el = state.refs.get(args.ref);
        if (state.snapshot !== state.revision || !el?.isConnected || !visible(el))
            throw new Error('Stale ref; take a new browser.snapshot');
        if (el.disabled || el.getAttribute('aria-disabled') === 'true')
            throw new Error('Element is disabled');
        if (action === 'click') {
            el.focus();
            const options = { bubbles: true, cancelable: true, view: window };
            for (const event of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
                el.dispatchEvent(event.startsWith('pointer') ? new PointerEvent(event, options) : new MouseEvent(event, options));
            }
            el.click();
        }
        else {
            const input = el;
            if (input.readOnly || !(['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable))
                throw new Error('Element is not editable');
            const text = String(args.text);
            el.focus();
            if (!el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })))
                throw new Error('Page rejected typing');
            if (el.isContentEditable)
                el.textContent = text;
            else {
                const prototype = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(el, text);
            }
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        state.revision++;
        state.changedAt = Date.now();
        return { ...page, performed: action };
    }
    throw new Error('Unsupported DOM action');
}`;

export function browserDomScript(
  key: string,
  action: string,
  args: Record<string, unknown>,
  identity: string,
): string {
  return `(() => { try { ${DOM_RUNTIME}; return JSON.stringify({ok:true,value:domRuntime(${JSON.stringify(key)},${JSON.stringify(action)},${JSON.stringify(args)},${JSON.stringify(identity)})}); } catch (_) { return JSON.stringify({ok:false,error: String(_.message || 'Browser DOM action failed')}); } })()`;
}
