/* eslint-env browser, es2022 */
/* eslint no-unused-vars: ["error", {"varsIgnorePattern":"^domRuntime$"}] */
'use strict';
function domRuntime(runtimeKey, action, args, identity) {
  const fail = (code, message, details = {}) => {
    throw Object.assign(new Error(message), { code, details });
  };
  const max = (value, fallback, limit) => {
    if (value == null) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > limit)
      fail('invalid_argument', 'Invalid output limit');
    return value;
  };
  const slice = (value, end) => {
    let result = value.slice(0, end);
    if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
    return result;
  };
  const compact = value =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const clean = (value, limit = 160) => slice(compact(value), limit);
  let state = window[runtimeKey];
  if (!state) {
    state = {
      nonce: Array.from(crypto.getRandomValues(new Uint32Array(2)), n =>
        n.toString(36).padStart(7, '0'),
      ).join(''),
      identity,
      revision: 0,
      sequence: 0,
      refs: new Map(),
      nodes: new Map(),
      changedAt: Date.now(),
      href: location.href,
    };
    const changed = () => {
      state.revision++;
      state.changedAt = Date.now();
    };
    state.observer = new MutationObserver(changed);
    state.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    for (const event of ['input', 'change', 'popstate', 'hashchange'])
      addEventListener(event, changed, true);
    window[runtimeKey] = state;
  }
  const mutated = state.observer.takeRecords().length;
  if (state.identity !== identity || state.href !== location.href || mutated) {
    state.identity = identity;
    state.href = location.href;
    state.revision++;
    state.changedAt = Date.now();
  }
  if (state.refRevision !== state.revision) {
    state.refs.clear();
    state.nodes.clear();
    state.refRevision = state.revision;
  }
  const sensitive = el =>
    el.matches(
      'input[type="password"],input[type="hidden"],[autocomplete="current-password"],[autocomplete="new-password"],[autocomplete="one-time-code"],[autocomplete^="cc-"]',
    );
  const rendered = el => {
    if (
      !el?.isConnected ||
      el.closest(
        '[hidden],[inert],[aria-hidden="true"],script,style,noscript,template',
      )
    )
      return false;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      )
        return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const visible = el => {
    const rect = el.getBoundingClientRect();
    return (
      rendered(el) &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    );
  };
  const publicUrl = value => {
    try {
      const url = new URL(value, location.href);
      return ['http:', 'https:'].includes(url.protocol)
        ? url.origin + url.pathname
        : url.protocol === 'about:'
          ? 'about:blank'
          : '';
    } catch (_) {
      return '';
    }
  };
  const page = {
    url: publicUrl(location.href),
    title: clean(document.title),
    generation: state.identity + ':' + state.revision,
  };
  if (action === 'annotation_check') {
    if (args.generation !== page.generation)
      fail('stale_ref', 'Page changed during screenshot; observe again');
    return { ...page, ready: true };
  }
  // Read rendered text nodes only, never form values or hidden descendants.
  const textOf = (el, limit = 65536) => {
    let text = '';
    const visit = node => {
      if (text.length >= limit) return;
      if (node.nodeType === 3) {
        text += slice(node.nodeValue, limit - text.length) + ' ';
        return;
      }
      if (
        node.nodeType !== 1 ||
        !rendered(node) ||
        sensitive(node) ||
        node.matches('input,textarea,select')
      )
        return;
      for (const child of node.childNodes) {
        visit(child);
        if (text.length >= limit) break;
      }
    };
    visit(el);
    return clean(text, limit);
  };
  const role = el =>
    el.getAttribute('role') ||
    {
      A: el.hasAttribute('href') ? 'link' : 'text',
      BUTTON: 'button',
      INPUT: ['checkbox', 'radio'].includes(el.type)
        ? el.type
        : el.type === 'range'
          ? 'slider'
          : ['button', 'submit', 'reset'].includes(el.type)
            ? 'button'
            : 'textbox',
      TEXTAREA: 'textbox',
      SELECT: el.multiple ? 'listbox' : 'combobox',
      OPTION: 'option',
      H1: 'heading',
      H2: 'heading',
      H3: 'heading',
      H4: 'heading',
      H5: 'heading',
      H6: 'heading',
      SUMMARY: 'button',
      IMG: 'img',
      MAIN: 'main',
      ARTICLE: 'article',
      NAV: 'navigation',
    }[el.tagName] ||
    (el.hasAttribute('contenteditable') ? 'textbox' : 'text');
  const label = el =>
    compact(
      Array.from(el.labels || [])
        .filter(rendered)
        .map(item => textOf(item, 160))
        .join(' '),
    );
  const name = el =>
    clean(
      el.getAttribute('aria-label') ||
        (el.getAttribute('aria-labelledby') || '')
          .split(/\s+/)
          .map(id => {
            const item = document.getElementById(id);
            return rendered(item) ? textOf(item, 160) : '';
          })
          .join(' ') ||
        label(el) ||
        el.getAttribute('alt') ||
        el.getAttribute('placeholder') ||
        textOf(el, 160),
      160,
    );
  const refFor = el => {
    let ref = state.nodes.get(el);
    if (!ref) {
      if (state.refs.size >= 500) {
        fail('result_too_large', 'Ref limit reached; take browser.snapshot');
      }
      ref = state.nonce + ':' + state.revision + ':e' + ++state.sequence;
      state.refs.set(ref, el);
      state.nodes.set(el, ref);
    }
    return ref;
  };
  const metadata = el => ({
    ref: refFor(el),
    tag: el.tagName.toLowerCase(),
    role: role(el),
    name: name(el),
    ...(el.disabled || el.getAttribute('aria-disabled') === 'true'
      ? { disabled: true }
      : {}),
    ...(sensitive(el) ? { sensitive: true } : {}),
    ...(el.matches('input[type=checkbox],input[type=radio]')
      ? { checked: el.checked }
      : el.hasAttribute('aria-checked')
        ? { checked: el.getAttribute('aria-checked') === 'true' }
        : {}),
    ...(el.tagName === 'SELECT' ? { selected_index: el.selectedIndex } : {}),
    ...(el.hasAttribute('aria-selected')
      ? { selected: el.getAttribute('aria-selected') === 'true' }
      : {}),
    ...(el.matches('input,textarea,[contenteditable="true"]')
      ? { editable: !el.readOnly && !el.disabled }
      : {}),
  });
  const query = selector => {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch (_) {
      return fail('invalid_selector', 'Invalid CSS selector');
    }
  };
  const interactive =
    'a[href],button,input:not([type="hidden"]),textarea,select,summary,h1,h2,h3,[role],[contenteditable="true"],[tabindex="0"]';
  const locate = target => {
    const fields = ['role', 'name', 'label', 'text', 'test_id'];
    const semantic = fields.some(field => target[field] !== undefined);
    if (target.ref !== undefined) {
      if (semantic || target.css !== undefined)
        fail('invalid_argument', 'Use a ref or a locator, not both');
      const el = state.refs.get(target.ref);
      if (!el || !rendered(el))
        fail('stale_ref', 'Stale ref; use browser.snapshot or browser.find');
      return [el];
    }
    if (!semantic && !target.css)
      fail('invalid_argument', 'Provide ref, semantic locator, or css');
    const match = (actual, expected) =>
      target.exact === false
        ? actual.toLowerCase().includes(expected.toLowerCase())
        : actual === expected;
    let matches = semantic
      ? query(
          target.text !== undefined || target.test_id !== undefined
            ? '*'
            : interactive + ',label,img,main,article,nav',
        ).filter(
          el =>
            rendered(el) &&
            fields.every(
              field =>
                target[field] === undefined ||
                match(
                  field === 'role'
                    ? role(el)
                    : field === 'name'
                      ? name(el)
                      : field === 'label'
                        ? label(el)
                        : field === 'text'
                          ? textOf(el)
                          : el.getAttribute('data-testid') ||
                            el.getAttribute('data-test-id') ||
                            '',
                  target[field],
                ),
            ),
        )
      : [];
    if (target.text !== undefined)
      matches = matches.filter(
        el => !matches.some(child => child !== el && el.contains(child)),
      );
    if (!matches.length && target.css)
      matches = query(target.css).filter(rendered);
    return matches;
  };
  const one = target => {
    const matches = locate(target);
    if (!matches.length) fail('not_found', 'No rendered element matched');
    if (matches.length > 1)
      fail(
        'ambiguous_target',
        'Target is ambiguous; use browser.find and choose a ref',
        {
          matches: matches.length,
          candidates: matches.slice(0, 5).map(metadata),
        },
      );
    return matches[0];
  };
  const target =
    args.target || (args.ref !== undefined ? { ref: args.ref } : args);
  const attrs = el => {
    const result = {};
    for (const attribute of [
      'id',
      'class',
      'role',
      'aria-label',
      'aria-checked',
      'aria-selected',
      'aria-expanded',
      'aria-disabled',
      'placeholder',
      'type',
      'name',
      'alt',
      'href',
      'src',
      'data-testid',
    ]) {
      if (!el.hasAttribute(attribute)) continue;
      result[attribute] = slice(
        ['href', 'src'].includes(attribute)
          ? publicUrl(el.getAttribute(attribute))
          : el.getAttribute(attribute),
        256,
      );
    }
    return result;
  };
  if (action === 'snapshot' || action === 'annotations') {
    if (action === 'snapshot') {
      state.refs.clear();
      state.nodes.clear();
    }
    const elements = query(interactive)
      .filter(visible)
      .slice(0, 200)
      .map(el => {
        const item = metadata(el);
        if (action === 'annotations') {
          const rect = el.getBoundingClientRect();
          item.x = rect.left;
          item.y = rect.top;
        }
        return item;
      });
    return {
      ...page,
      elements,
      ...(action === 'annotations'
        ? { viewport_width: innerWidth, viewport_height: innerHeight }
        : {}),
    };
  }
  if (action === 'find') {
    const matches = locate(target),
      limit = max(args.limit, 20, 50);
    return {
      ...page,
      matches: matches.length,
      elements: matches.slice(0, limit).map(metadata),
      truncated: matches.length > limit,
    };
  }
  if (action === 'get') {
    const limit = max(args.max_chars, 4000, 16000),
      property = args.property;
    if (property === 'url' || property === 'title')
      return { ...page, value: page[property] };
    const el = one(target);
    if (sensitive(el))
      fail('sensitive_target', 'Sensitive field cannot be read');
    let value;
    if (property === 'text') value = textOf(el, limit + 1);
    else if (property === 'value') {
      if (!el.matches('input,textarea,select'))
        fail('not_editable', 'Target has no form value');
      value = el.value;
    } else if (property === 'attributes') value = attrs(el);
    else if (property === 'html') {
      // Reconstruct a sanitized visible tree; never return raw outerHTML.
      const escape = escaped =>
        String(escaped)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      let used = 0;
      const serialize = (node, depth) => {
        if (used > limit || depth > 20) return '';
        if (node.nodeType === 3) {
          const part = escape(
            slice(node.nodeValue, limit + 1 - Math.min(used, limit)),
          );
          used += part.length;
          return part;
        }
        if (
          node.nodeType !== 1 ||
          !rendered(node) ||
          sensitive(node) ||
          node.matches('input,textarea,select')
        )
          return '';
        const tag = node.tagName.toLowerCase();
        const open =
          '<' +
          tag +
          Object.entries(attrs(node))
            .map(([k, v]) => ' ' + k + '="' + escape(v) + '"')
            .join('') +
          '>';
        used += open.length;
        let children = '';
        for (const child of node.childNodes) {
          children += serialize(child, depth + 1);
          if (used > limit) break;
        }
        return open + children + '</' + tag + '>';
      };
      value = serialize(el, 0);
    } else fail('invalid_argument', 'Unsupported get property');
    if (typeof value !== 'string') {
      const bounded = {};
      let used = 2,
        truncated = false;
      for (const [key, valueString] of Object.entries(value)) {
        const cost = JSON.stringify({ [key]: valueString }).length;
        if (used + cost > limit) {
          truncated = true;
          break;
        }
        bounded[key] = valueString;
        used += cost;
      }
      return { ...page, value: bounded, truncated };
    }
    return {
      ...page,
      value: slice(value, limit),
      truncated: value.length > limit,
    };
  }
  if (action === 'extract') {
    const size = max(args.chunk_size, 4000, 12000),
      start = args.start || 0;
    if (!Number.isInteger(start) || start < 0 || start > 262144)
      fail('invalid_argument', 'Invalid start');
    if (args.generation && args.generation !== page.generation)
      fail('stale_content', 'Page content changed; restart extraction');
    const el = args.target
      ? one(args.target)
      : query('main,[role="main"]').find(rendered) ||
        query('article').find(rendered) ||
        document.body;
    let content = '',
      capped = false;
    const append = value => {
      if (content.length + value.length > 262144) capped = true;
      content = slice(content + value, 262144);
    };
    const visit = node => {
      if (capped) return;
      if (node.nodeType === 3) {
        append(node.nodeValue.replace(/\s+/g, ' '));
        return;
      }
      if (
        node.nodeType !== 1 ||
        !rendered(node) ||
        sensitive(node) ||
        node.matches(
          'input,textarea,select,nav,header,footer,aside,button,svg,iframe,canvas,[role="navigation"],[role="banner"],[role="contentinfo"]',
        )
      )
        return;
      const tag = node.tagName.toLowerCase(),
        block =
          /^(p|div|section|article|main|li|tr|h[1-6]|blockquote|pre|br)$/.test(
            tag,
          );
      if (block) append('\n');
      if (/^h[1-6]$/.test(tag)) append('#'.repeat(Number(tag[1])) + ' ');
      if (tag === 'li') append('- ');
      for (const child of node.childNodes) {
        visit(child);
        if (capped) break;
      }
      if (tag === 'td' || tag === 'th') append(' | ');
      if (block) append('\n');
    };
    if (rendered(el)) visit(el);
    content = content
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const points = Array.from(content);
    if (start > points.length)
      fail('invalid_argument', 'Start exceeds content length');
    const end = Math.min(start + size, points.length);
    return {
      ...page,
      content: points.slice(start, end).join(''),
      start,
      end,
      total_chars: points.length,
      next_start: end < points.length ? end : null,
      truncated: capped,
    };
  }
  if (action === 'wait' || action === 'wait_for_dom') {
    const condition =
      args.condition ||
      (args.target ? 'target' : args.selector ? 'selector' : 'stable');
    let ready;
    if (condition === 'target') ready = locate(args.target).length > 0;
    else if (condition === 'selector')
      ready = query(args.selector).some(rendered);
    else if (condition === 'text')
      ready = textOf(document.body, 262144).includes(args.text);
    else if (condition === 'url') ready = location.href.includes(args.url);
    else if (condition === 'url_change')
      ready = args.previous_url !== location.href;
    else if (condition === 'stable')
      ready = Date.now() - state.changedAt >= (args.stable_ms || 300);
    else fail('invalid_argument', 'Invalid wait condition');
    return { ...page, ready, condition };
  }
  if (action === 'scroll') {
    scrollBy({
      left: Number(args.x || 0),
      top: Number(args.y),
      behavior: 'instant',
    });
    state.revision++;
    state.changedAt = Date.now();
    return { ...page, scrolled: true };
  }
  if (
    ['click', 'type', 'keys', 'select', 'check', 'uncheck'].includes(action)
  ) {
    const el = one(target);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true')
      fail('disabled_target', 'Element is disabled');
    el.focus();
    if (action === 'click') {
      const options = { bubbles: true, cancelable: true, view: window };
      for (const event of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'])
        el.dispatchEvent(
          event.startsWith('pointer') && window.PointerEvent
            ? new PointerEvent(event, options)
            : new MouseEvent(event, options),
        );
      el.click();
    } else if (action === 'type') {
      if (
        el.readOnly ||
        el.matches(
          'input[type=checkbox],input[type=radio],input[type=file],input[type=button],input[type=submit],input[type=reset]',
        ) ||
        !(['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable)
      )
        fail('not_editable', 'Element is not editable');
      if (
        !el.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: args.text,
          }),
        )
      )
        fail('input_rejected', 'Page rejected typing');
      if (el.isContentEditable) el.textContent = args.text;
      else
        Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype,
          'value',
        ).set.call(el, args.text);
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: args.text,
        }),
      );
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (action === 'select') {
      if (el.tagName !== 'SELECT' || el.multiple)
        fail('not_select', 'Target must be a single-choice native select');
      const matches = Array.from(el.options).filter(
        option =>
          !option.disabled &&
          !option.closest('optgroup[disabled]') &&
          (option.label === args.option || option.value === args.option),
      );
      if (!matches.length)
        fail('option_not_found', 'No enabled option matched');
      if (matches.length > 1)
        fail('ambiguous_option', 'Option label/value is ambiguous');
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
      ).set.call(el, matches[0].value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (action === 'check' || action === 'uncheck') {
      if (!el.matches('input[type="checkbox"],input[type="radio"]'))
        fail('not_checkable', 'Target must be a native checkbox or radio');
      if (el.type === 'radio' && action === 'uncheck')
        fail('not_checkable', 'Select another radio to change the group');
      const desired = action === 'check';
      if (el.checked !== desired) el.click();
      if (el.checked !== desired)
        fail('input_rejected', 'Page rejected checked state');
    } else {
      if (sensitive(el))
        fail('sensitive_target', 'Keys are unavailable on sensitive fields');
      const parts = args.key.split('+'),
        keyName = parts.pop();
      const supported = [
        'Enter',
        'Escape',
        'Tab',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'Backspace',
        'Delete',
        'a',
        'A',
        ' ',
      ];
      if (
        !supported.includes(keyName) ||
        parts.some(part => !['Control', 'Meta', 'Shift', 'Alt'].includes(part))
      )
        fail('invalid_argument', 'Unsupported key');
      const options = {
        key: keyName,
        bubbles: true,
        cancelable: true,
        ctrlKey: parts.includes('Control'),
        metaKey: parts.includes('Meta'),
        shiftKey: parts.includes('Shift'),
        altKey: parts.includes('Alt'),
      };
      const previousOffset = offset => {
        const last = el.value.charCodeAt(offset - 1);
        return Math.max(0, offset - (last >= 0xdc00 && last <= 0xdfff ? 2 : 1));
      };
      const nextOffset = offset =>
        Math.min(
          el.value.length,
          offset + (el.value.codePointAt(offset) > 0xffff ? 2 : 1),
        );
      const allowed = el.dispatchEvent(new KeyboardEvent('keydown', options));
      if (allowed) {
        if (
          (options.ctrlKey || options.metaKey) &&
          keyName.toLowerCase() === 'a' &&
          el.setSelectionRange &&
          el.selectionStart !== null
        )
          el.setSelectionRange(0, el.value.length);
        else if (
          parts.every(part => part === 'Shift') &&
          ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(keyName) &&
          el.setSelectionRange &&
          el.selectionStart !== null
        ) {
          const start = el.selectionStart,
            end = el.selectionEnd;
          const backward = el.selectionDirection === 'backward';
          const caret = backward ? start : end;
          const destination =
            keyName === 'Home'
              ? 0
              : keyName === 'End'
                ? el.value.length
                : keyName === 'ArrowLeft'
                  ? !options.shiftKey && start !== end
                    ? start
                    : previousOffset(caret)
                  : !options.shiftKey && start !== end
                    ? end
                    : nextOffset(caret);
          if (options.shiftKey) {
            const anchor = backward ? end : start;
            el.setSelectionRange(
              Math.min(anchor, destination),
              Math.max(anchor, destination),
              destination < anchor ? 'backward' : 'forward',
            );
          } else el.setSelectionRange(destination, destination);
        } else if (
          !parts.length &&
          ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(keyName) &&
          el.tagName === 'SELECT' &&
          !el.multiple
        ) {
          const selectable = Array.from(el.options).filter(
            option => !option.disabled && !option.closest('optgroup[disabled]'),
          );
          const index = selectable.findIndex(option => option.selected);
          const next =
            selectable[
              keyName === 'Home'
                ? 0
                : keyName === 'End'
                  ? selectable.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        selectable.length - 1,
                        index + (keyName === 'ArrowUp' ? -1 : 1),
                      ),
                    )
            ];
          if (next && !next.selected) {
            Object.getOwnPropertyDescriptor(
              HTMLSelectElement.prototype,
              'value',
            ).set.call(el, next.value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else if (
          !parts.length &&
          ['Backspace', 'Delete'].includes(keyName) &&
          el.matches(
            'textarea,input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="url"],input[type="tel"]',
          ) &&
          !el.readOnly
        ) {
          const start = el.selectionStart ?? el.value.length,
            end = el.selectionEnd ?? start;
          const from =
            keyName === 'Backspace' && start === end
              ? previousOffset(start)
              : start;
          const to =
            keyName === 'Delete' && start === end ? nextOffset(end) : end;
          const inputType =
            keyName === 'Backspace'
              ? 'deleteContentBackward'
              : 'deleteContentForward';
          if (
            el.dispatchEvent(
              new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType,
              }),
            )
          ) {
            Object.getOwnPropertyDescriptor(
              el.tagName === 'TEXTAREA'
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype,
              'value',
            ).set.call(el, el.value.slice(0, from) + el.value.slice(to));
            if (el.selectionStart !== null) el.setSelectionRange(from, from);
            el.dispatchEvent(
              new InputEvent('input', { bubbles: true, inputType }),
            );
          }
        } else if (!parts.length && keyName === 'Enter') {
          if (el.matches('button,summary,a[href],input[type="submit"]'))
            el.click();
          else if (el.form && el.tagName === 'INPUT') el.form.requestSubmit();
        } else if (keyName === 'Tab' && parts.every(part => part === 'Shift')) {
          const controls = query(
            'a[href],button,input,textarea,select,[tabindex]',
          ).filter(
            item => rendered(item) && !item.disabled && item.tabIndex >= 0,
          );
          const index = controls.indexOf(el),
            next =
              controls[
                (index + (options.shiftKey ? -1 : 1) + controls.length) %
                  controls.length
              ];
          next?.focus();
        } else if (
          !parts.length &&
          keyName === ' ' &&
          el.matches('button,input[type="checkbox"],input[type="radio"]')
        )
          el.click();
      }
      el.dispatchEvent(new KeyboardEvent('keyup', options));
    }
    state.revision++;
    state.changedAt = Date.now();
    return { ...page, performed: action };
  }
  fail('unsupported_action', 'Unsupported DOM action');
}
