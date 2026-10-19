import { terminalRendererKey } from './terminalRenderer';
import { composeTerminalSubmission } from './terminalSubmission';

export interface ComposeAttachment {
  readonly id: number;
  readonly remotePath: string;
  readonly previewUri: string | null;
  readonly dispose: () => void;
}

export interface QueuedComposerMessage {
  readonly id: number;
  readonly text: string;
  readonly pasteEvents: readonly string[];
  readonly historyEntry: string;
  readonly attachments: readonly ComposeAttachment[];
  readonly sending: boolean;
  readonly attempts: number;
  readonly error: string | null;
}

interface PendingImagePaste {
  cancel: () => void;
}

export interface TerminalComposerSnapshot {
  readonly restoration: number;
  readonly composeOpen: boolean;
  readonly composeExpanded: boolean;
  readonly text: string;
  readonly attachments: readonly ComposeAttachment[];
  readonly queue: readonly QueuedComposerMessage[];
  readonly imagePastes: ReadonlyMap<number, PendingImagePaste>;
}

export type PersistedComposerState = Pick<TerminalComposerSnapshot, 'text' | 'composeOpen' | 'composeExpanded'>;

const EMPTY_COMPOSER: TerminalComposerSnapshot = {
  restoration: 0,
  composeOpen: false,
  composeExpanded: false,
  text: '',
  attachments: [],
  queue: [],
  imagePastes: new Map(),
};

/** Authoritative UI drafts and ownership of their native attachment resources. */
export class TerminalComposerStore {
  private readonly drafts = new Map<string, TerminalComposerSnapshot>();
  private readonly listeners = new Set<(targetKey: string) => void>();
  private messageSequence = 0;
  private attachmentSequence = 0;

  subscribe = (listener: (targetKey: string) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot = (targetKey: string): TerminalComposerSnapshot =>
    this.drafts.get(targetKey) ?? EMPTY_COMPOSER;

  restore(targetKey: string, state: PersistedComposerState): void {
    const current = this.snapshot(targetKey);
    this.publish(targetKey, { ...current, ...state, restoration: current.restoration + 1 });
  }

  nextAttachmentId(): number {
    return --this.attachmentSequence;
  }

  setToggles(targetKey: string, composeOpen: boolean, composeExpanded = false): void {
    const current = this.snapshot(targetKey);
    if (current.composeOpen !== composeOpen || current.composeExpanded !== composeExpanded)
      this.publish(targetKey, { ...current, composeOpen, composeExpanded });
  }

  setText(targetKey: string, text: string): void {
    const current = this.snapshot(targetKey);
    if (current.text !== text) this.publish(targetKey, { ...current, text });
  }

  addAttachment(targetKey: string, attachment: ComposeAttachment): void {
    const current = this.snapshot(targetKey);
    this.publish(targetKey, {
      ...current,
      attachments: [...current.attachments, attachment],
    });
  }

  removeAttachment(targetKey: string, id: number): void {
    const current = this.snapshot(targetKey);
    const attachment = current.attachments.find(item => item.id === id);
    if (!attachment) return;
    this.publish(targetKey, {
      ...current,
      attachments: current.attachments.filter(item => item.id !== id),
    });
    attachment.dispose();
  }

  enqueue(
    targetKey: string,
    text: string,
    attachments: readonly ComposeAttachment[],
    consumeDraft = false,
  ): QueuedComposerMessage | null {
    const current = this.snapshot(targetKey);
    if (consumeDraft && current.imagePastes.size) return null;
    const submission = composeTerminalSubmission(
      text,
      attachments.map(attachment => attachment.remotePath),
    );
    if (!submission.historyEntry) return null;
    const message: QueuedComposerMessage = {
      id: ++this.messageSequence,
      text,
      ...submission,
      attachments: [...attachments],
      sending: false,
      attempts: 0,
      error: null,
    };
    this.publish(targetKey, {
      ...current,
      ...(consumeDraft ? { text: '', attachments: [] } : {}),
      queue: [...current.queue, message],
    });
    return message;
  }

  submitDraft(targetKey: string): QueuedComposerMessage | null {
    const draft = this.snapshot(targetKey);
    return this.enqueue(targetKey, draft.text, draft.attachments, true);
  }

  unqueue(targetKey: string, id: number): { wasHead: boolean } | null {
    const current = this.snapshot(targetKey);
    const message = current.queue.find(item => item.id === id);
    if (!message || message.sending) return null;
    this.publish(targetKey, {
      ...current,
      text: [message.text, current.text].filter(Boolean).join('\n'),
      attachments: [...message.attachments, ...current.attachments],
      queue: current.queue.filter(item => item.id !== id),
    });
    return { wasHead: current.queue[0]?.id === id };
  }

  markSending(targetKey: string, id: number): void {
    this.updateMessage(targetKey, id, message => ({
      ...message,
      sending: true,
      error: null,
    }));
  }

  markFailed(targetKey: string, id: number, error: string): void {
    this.updateMessage(targetKey, id, message => ({
      ...message,
      sending: false,
      attempts: message.attempts + 1,
      error,
    }));
  }

  complete(targetKey: string, id: number): QueuedComposerMessage | null {
    const current = this.snapshot(targetKey);
    const message = current.queue.find(item => item.id === id);
    if (!message) return null;
    this.publish(targetKey, {
      ...current,
      queue: current.queue.filter(item => item.id !== id),
    });
    for (const attachment of message.attachments) attachment.dispose();
    return message;
  }

  beginImagePaste(targetKey: string, cancel: () => void): number {
    const id = this.nextAttachmentId();
    const current = this.snapshot(targetKey);
    const imagePastes = new Map(current.imagePastes);
    imagePastes.set(id, { cancel });
    this.publish(targetKey, { ...current, imagePastes });
    return id;
  }

  finishImagePaste(
    targetKey: string,
    id: number,
    attachment?: Omit<ComposeAttachment, 'id'>,
  ): void {
    const current = this.snapshot(targetKey);
    if (!current.imagePastes.has(id)) {
      attachment?.dispose();
      return;
    }
    const imagePastes = new Map(current.imagePastes);
    imagePastes.delete(id);
    this.publish(targetKey, {
      ...current,
      imagePastes,
      attachments: attachment
        ? [...current.attachments, { ...attachment, id }]
        : current.attachments,
    });
  }

  retain(targetKeys: ReadonlySet<string>): void {
    for (const key of this.drafts.keys()) {
      // A disconnected host can temporarily disappear from renderer targets.
      if (!targetKeys.has(key)) this.releaseTargetResources(key);
    }
  }

  /** Use the authoritative terminal rails, which include disconnected hosts. */
  retainTerminals(targetKeys: ReadonlySet<string>, sessionId?: string): void {
    const prefix = sessionId === undefined ? '' : terminalRendererKey(sessionId, '');
    for (const key of this.drafts.keys()) {
      if (key.startsWith(prefix) && !targetKeys.has(key)) this.remove(key);
    }
  }

  removeSession(sessionId: string): void {
    const prefix = terminalRendererKey(sessionId, '');
    for (const key of this.drafts.keys()) {
      if (key.startsWith(prefix)) this.remove(key);
    }
  }

  releaseResources(): void {
    for (const key of this.drafts.keys()) this.releaseTargetResources(key);
  }

  private updateMessage(
    targetKey: string,
    id: number,
    update: (message: QueuedComposerMessage) => QueuedComposerMessage,
  ): void {
    const current = this.snapshot(targetKey);
    if (!current.queue.some(message => message.id === id)) return;
    this.publish(targetKey, {
      ...current,
      queue: current.queue.map(message =>
        message.id === id ? update(message) : message,
      ),
    });
  }

  private remove(targetKey: string): void {
    const current = this.snapshot(targetKey);
    this.drafts.delete(targetKey);
    this.emit(targetKey);
    this.disposeResources(current);
  }

  private disposeResources(current: TerminalComposerSnapshot): void {
    for (const paste of current.imagePastes.values()) paste.cancel();
    for (const attachment of current.attachments) attachment.dispose();
    for (const message of current.queue) {
      for (const attachment of message.attachments) attachment.dispose();
    }
  }

  private releaseTargetResources(targetKey: string): void {
    const current = this.snapshot(targetKey);
    if (!current.attachments.length && !current.queue.length && !current.imagePastes.size) return;
    this.publish(targetKey, {
      ...EMPTY_COMPOSER,
      text: current.text,
      composeOpen: current.composeOpen,
      composeExpanded: current.composeExpanded,
      restoration: current.restoration,
    });
    this.disposeResources(current);
  }

  private publish(targetKey: string, snapshot: TerminalComposerSnapshot): void {
    if (!snapshot.composeOpen && !snapshot.composeExpanded && !snapshot.text && !snapshot.attachments.length && !snapshot.queue.length && !snapshot.imagePastes.size)
      this.drafts.delete(targetKey);
    else this.drafts.set(targetKey, snapshot);
    this.emit(targetKey);
  }

  private emit(targetKey: string): void {
    for (const listener of this.listeners) listener(targetKey);
  }
}
