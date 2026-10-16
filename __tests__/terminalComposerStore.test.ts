import { TerminalComposerStore, type ComposeAttachment } from '../src/lib/terminalComposerStore';
import { terminalRendererKey } from '../src/lib/terminalRenderer';

const first = terminalRendererKey('host-1', 'terminal-1');
const second = terminalRendererKey('host-2', 'terminal-1');
const attachment = (id: number): ComposeAttachment => ({
  id, remotePath: `/remote/file-${id}`, previewUri: null, dispose: jest.fn(),
});

test('submitting transfers the complete draft to its queue in one notification', () => {
  const store = new TerminalComposerStore();
  const file = attachment(1);
  store.setText(first, 'hello');
  store.addAttachment(first, file);
  store.setText(second, 'other draft');
  const otherDraft = store.snapshot(second);
  const observed: ReturnType<typeof store.snapshot>[] = [];
  store.subscribe(() => observed.push(store.snapshot(first)));

  const queued = store.submitDraft(first)!;

  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ text: '', attachments: [], queue: [queued] });
  expect(queued).toMatchObject({ text: 'hello', attachments: [file], pasteEvents: ['hello', file.remotePath] });
  expect(store.snapshot(second)).toBe(otherDraft);
  expect(file.dispose).not.toHaveBeenCalled();
  expect(store.submitDraft(first)).toBeNull();
});

test('retry and unqueue preserve new edits and transfer attachment ownership exactly once', () => {
  const store = new TerminalComposerStore();
  const queuedFile = attachment(1);
  const draftFile = attachment(2);
  store.setText(first, 'queued');
  store.addAttachment(first, queuedFile);
  const message = store.submitDraft(first)!;
  store.markSending(first, message.id);
  expect(store.unqueue(first, message.id)).toBeNull();
  store.markFailed(first, message.id, 'offline');
  store.setText(first, 'new edit');
  store.addAttachment(first, draftFile);
  const listener = jest.fn();
  store.subscribe(listener);

  expect(store.unqueue(first, message.id)).toEqual({ wasHead: true });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(store.snapshot(first)).toMatchObject({ text: 'queued\nnew edit', attachments: [queuedFile, draftFile], queue: [] });
  expect(store.complete(first, message.id)).toBeNull();
  expect(queuedFile.dispose).not.toHaveBeenCalled();
  store.removeAttachment(first, queuedFile.id);
  store.releaseResources();
  store.releaseResources();
  expect(queuedFile.dispose).toHaveBeenCalledTimes(1);
  expect(draftFile.dispose).toHaveBeenCalledTimes(1);
  expect(store.snapshot(first).text).toBe('queued\nnew edit');
});

test('a completed send leaves subsequent edits intact and disposes only its attachments', () => {
  const store = new TerminalComposerStore();
  const sentFile = attachment(1);
  const draftFile = attachment(2);
  const message = store.enqueue(first, 'send', [sentFile])!;
  store.setText(first, 'next');
  store.addAttachment(first, draftFile);
  store.markSending(first, message.id);
  store.markFailed(first, message.id, 'retry');
  expect(store.snapshot(first).queue[0]).toMatchObject({ sending: false, attempts: 1, error: 'retry' });
  store.markSending(first, message.id);
  expect(store.snapshot(first).queue[0]).toMatchObject({ sending: true, attempts: 1, error: null });

  expect(store.complete(first, message.id)).not.toBeNull();
  expect(store.complete(first, message.id)).toBeNull();
  expect(store.snapshot(first)).toMatchObject({ text: 'next', attachments: [draftFile], queue: [] });
  expect(sentFile.dispose).toHaveBeenCalledTimes(1);
  expect(draftFile.dispose).not.toHaveBeenCalled();
});

test('pending images block only their own target and finish in the originating draft', () => {
  const store = new TerminalComposerStore();
  store.setText(first, 'first');
  store.setText(second, 'second');
  const image = attachment(1);
  const id = store.beginImagePaste(first, jest.fn());
  expect(store.submitDraft(first)).toBeNull();
  expect(store.submitDraft(second)).not.toBeNull();
  const listener = jest.fn();
  store.subscribe(listener);

  store.finishImagePaste(first, id, image);

  expect(listener).toHaveBeenCalledTimes(1);
  expect(store.snapshot(first).imagePastes.size).toBe(0);
  expect(store.snapshot(first).attachments).toEqual([{ ...image, id }]);
  expect(store.snapshot(second).attachments).toEqual([]);
  expect(store.submitDraft(first)).not.toBeNull();
});

test.each(['remove-target', 'unmount'] as const)('late images are discarded after %s, including when the target is reused', cleanup => {
  const store = new TerminalComposerStore();
  const cancel = jest.fn();
  const id = store.beginImagePaste(first, cancel);
  store.setText(first, 'saved text');
  if (cleanup === 'remove-target') store.retain(new Set());
  else store.releaseResources();
  const nextId = store.beginImagePaste(first, jest.fn());
  const lateImage = attachment(1);

  store.finishImagePaste(first, id, lateImage);

  expect(cancel).toHaveBeenCalledTimes(1);
  expect(lateImage.dispose).toHaveBeenCalledTimes(1);
  expect(store.snapshot(first).attachments).toEqual([]);
  expect([...store.snapshot(first).imagePastes.keys()]).toEqual([nextId]);
  expect(store.snapshot(first).text).toBe('saved text');
});

test('removing a host releases its resources without removing another host with the same terminal ID', () => {
  const store = new TerminalComposerStore();
  const file = attachment(1);
  store.enqueue(first, 'send', [file]);
  store.setText(second, 'other host');
  const otherDraft = store.snapshot(second);
  store.removeSession('host-1');
  store.removeSession('host-1');
  expect(file.dispose).toHaveBeenCalledTimes(1);
  expect(store.snapshot(first).queue).toEqual([]);
  expect(store.snapshot(second)).toBe(otherDraft);
});
