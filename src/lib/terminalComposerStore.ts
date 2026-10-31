import { terminalRendererKey } from './terminalRenderer';
import type { TerminalRenderTarget } from './terminalRenderer';
import {
  TerminalSubmissionQueue,
  TerminalSubmissionStatus,
  TerminalSubmissionFailure,
  TerminalSubmissionPlatformError,
  type TerminalSubmissionMessage,
  type TerminalSubmissionPlatform,
} from 'react-native-whip-ssh/src/terminalSubmissions';

export interface ComposeAttachment {
  readonly id: number;
  readonly remotePath: string;
  readonly previewUri: string | null;
  readonly dispose: () => void;
}

export interface QueuedComposerMessage {
  readonly id: string;
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
  readonly keyboardEnabled: boolean;
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
  keyboardEnabled: false,
  composeOpen: false,
  composeExpanded: false,
  text: '',
  attachments: [],
  queue: [],
  imagePastes: new Map(),
};

const SUBMISSION_ERRORS: Record<TerminalSubmissionFailure, string> = {
  [TerminalSubmissionFailure.Unavailable]: 'Terminal is unavailable; input has not been sent',
  [TerminalSubmissionFailure.TargetChanged]: 'Terminal connection was replaced; restore the message to edit it',
  [TerminalSubmissionFailure.WriteInterrupted]: 'Input may have been partially sent. Inspect the terminal before restoring this message',
};

/** Authoritative UI drafts and ownership of their native attachment resources. */
export class TerminalComposerStore {
  private readonly drafts = new Map<string, TerminalComposerSnapshot>();
  private readonly listeners = new Set<(targetKey: string) => void>();
  private readonly submissions = new TerminalSubmissionQueue();
  private readonly queuedAttachments = new Map<string, readonly ComposeAttachment[]>();
  private attachmentSequence = 0;

  attachSubmissions(
    submit: TerminalSubmissionPlatform['submit'],
    onHistoryEntry: (entry: string) => void,
  ): () => void {
    const changed = (key: string) => {
      const completed = this.submissions.takeCompleted(key);
      for (const message of completed) {
        for (const attachment of this.queuedAttachments.get(message.id) ?? []) attachment.dispose();
        this.queuedAttachments.delete(message.id);
      }
      this.refreshQueue(key);
      for (const message of completed) onHistoryEntry(message.historyEntry);
    };
    this.submissions.attach({
      changed,
      submit: async (...args) => {
        try { await submit(...args); }
        catch { throw new TerminalSubmissionPlatformError.Unavailable(); }
      },
    });
    for (const key of this.drafts.keys()) changed(key);
    return () => this.submissions.detach();
  }

  updateSubmissionTargets(targets: readonly TerminalRenderTarget[]): void {
    this.submissions.updateTargets(targets.flatMap(target => {
      try {
        const runtime = target.client.native;
        return [{
          key: target.key,
          runtimeId: runtime.runtimeId,
          runtimeIncarnation: BigInt(runtime.runtimeIncarnation),
          terminalId: target.session.terminalId,
          paneId: target.session.paneId,
          ssh: target.session.kind === 'ssh',
          online: target.session.status === 'connected',
        }];
      } catch { return []; }
    }));
    for (const target of targets) this.refreshQueue(target.key);
  }

  startSubmissions(): void { this.submissions.start(); }

  private projectMessage(message: TerminalSubmissionMessage): QueuedComposerMessage {
    return {
      id: message.id,
      text: message.text,
      pasteEvents: message.pasteEvents,
      historyEntry: message.historyEntry,
      attachments: this.queuedAttachments.get(message.id) ?? [],
      sending: message.status === TerminalSubmissionStatus.Preparing || message.status === TerminalSubmissionStatus.Writing,
      attempts: message.attempts,
      error: message.failure === undefined ? null : SUBMISSION_ERRORS[message.failure],
    };
  }

  private refreshQueue(key: string): void {
    const current = this.snapshot(key);
    const queue = this.submissions.view(key).map(message => {
      const projection = this.projectMessage(message);
      const previous = current.queue.find(item => item.id === message.id);
      return previous?.sending === projection.sending && previous.attempts === projection.attempts && previous.error === projection.error
        ? previous : projection;
    });
    if (queue.length === current.queue.length && queue.every((message, index) => message === current.queue[index])) return;
    this.publish(key, { ...current, queue });
  }

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

  setKeyboardEnabled(targetKey: string, keyboardEnabled: boolean): void {
    const current = this.snapshot(targetKey);
    if (current.keyboardEnabled !== keyboardEnabled)
      this.publish(targetKey, { ...current, keyboardEnabled });
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
    const submission = this.submissions.enqueue(targetKey, text, attachments.map(attachment => ({
      id: BigInt(attachment.id), remotePath: attachment.remotePath,
    })));
    if (!submission) return null;
    this.queuedAttachments.set(submission.id, [...attachments]);
    const message = this.projectMessage(submission);
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

  unqueue(targetKey: string, id: string): { wasHead: boolean } | null {
    const current = this.snapshot(targetKey);
    const submission = this.submissions.unqueue(targetKey, id);
    if (!submission) return null;
    const message = this.projectMessage(submission);
    this.queuedAttachments.delete(id);
    this.publish(targetKey, {
      ...current,
      text: [message.text, current.text].filter(Boolean).join('\n'),
      attachments: [...message.attachments, ...current.attachments],
      queue: this.submissions.view(targetKey).map(item => this.projectMessage(item)),
    });
    return { wasHead: current.queue[0]?.id === id };
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

  private remove(targetKey: string): void {
    const current = this.snapshot(targetKey);
    this.submissions.remove(targetKey);
    for (const message of current.queue) this.queuedAttachments.delete(message.id);
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
    if (!current.attachments.length && !current.imagePastes.size) return;
    this.publish(targetKey, {
      ...EMPTY_COMPOSER,
      text: current.text,
      composeOpen: current.composeOpen,
      composeExpanded: current.composeExpanded,
      restoration: current.restoration,
      keyboardEnabled: current.keyboardEnabled,
      queue: current.queue,
    });
    for (const paste of current.imagePastes.values()) paste.cancel();
    for (const attachment of current.attachments) attachment.dispose();
  }

  private publish(targetKey: string, snapshot: TerminalComposerSnapshot): void {
    if (!snapshot.keyboardEnabled && !snapshot.composeOpen && !snapshot.composeExpanded && !snapshot.text && !snapshot.attachments.length && !snapshot.queue.length && !snapshot.imagePastes.size)
      this.drafts.delete(targetKey);
    else this.drafts.set(targetKey, snapshot);
    this.emit(targetKey);
  }

  private emit(targetKey: string): void {
    for (const listener of this.listeners) listener(targetKey);
  }
}
