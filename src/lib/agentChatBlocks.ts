import type { TranscriptMessage, TranscriptPart, TranscriptToolPart, TranscriptTurn } from '../agentChat';

type BlockContent =
  | { type: 'user'; message: TranscriptMessage }
  | { type: 'part'; part: TranscriptPart; streaming: boolean }
  | { type: 'thinking' }
  | { type: 'error'; error: string }
  | { type: 'changes'; turn: TranscriptTurn }
  | { type: 'diff'; file: TranscriptTurn['diffs'][number] }
  | { type: 'meta'; turn: TranscriptTurn };

export type ChatBlock = BlockContent & {
  id: string;
  turnId: string;
  spacing: 'turn' | 'part' | 'none';
};

export function isRunningTool(part: TranscriptToolPart): boolean {
  return part.state.status === 'pending' || part.state.status === 'running';
}

const QUESTION_TOOLS = new Set(['question', 'askuserquestion', 'request_user_input']);

export function isQuestionTool(part: TranscriptToolPart): boolean {
  return QUESTION_TOOLS.has(part.tool.toLowerCase().split('.').at(-1) ?? '');
}

function renderable(part: TranscriptPart): boolean {
  if (part.type === 'text' || part.type === 'reasoning') return Boolean(part.text.trim());
  // Claude retains original tool names, including TodoWrite, without a separate plan.
  if (part.type === 'tool') return part.tool !== 'todowrite' || part.state.status === 'error';
  return part.type === 'plan' || part.type === 'notice';
}

/** Presentation rows only: transcript ownership and reconciliation stay in Rust. */
export function transcriptBlocks(
  turns: readonly TranscriptTurn[],
  agentWorking: boolean,
  expanded: ReadonlySet<string>,
): ChatBlock[] {
  return turns.flatMap((turn, turnIndex) => {
    const rows: ChatBlock[] = [];
    const key = (...parts: string[]) => JSON.stringify([turn.id, ...parts]);
    const push = (id: string, content: BlockContent) => rows.push({
      ...content,
      id,
      turnId: turn.id,
      spacing: rows.length === 0
        ? (turnIndex ? 'turn' : 'none')
        : content.type === 'meta' || content.type === 'changes' ? 'none' : 'part',
    });
    if (turn.user) push(key('user', turn.user.id), { type: 'user', message: turn.user });
    const parts = turn.assistants.flatMap(message => message.parts
      .filter(renderable)
      .map(part => ({ part, message, id: key('part', message.id, part.id) })));
    const tail = parts.at(-1);
    const working = turnIndex === turns.length - 1 && (agentWorking || turn.status === 'working');
    const streamingId = working && tail && tail.message.completedAt === undefined
      && (tail.part.type === 'text' || tail.part.type === 'reasoning') ? tail.id : undefined;
    for (const item of parts) {
      push(item.id, { type: 'part', part: item.part, streaming: item.id === streamingId });
    }
    if (working && turn.status !== 'error' && !streamingId
      && !parts.some(({ part }) => part.type === 'tool' && isRunningTool(part))) {
      push(key('thinking'), { type: 'thinking' });
    }
    for (const message of turn.assistants) {
      if (message.error) push(key('error', message.id), { type: 'error', error: message.error });
    }
    if (turn.diffs.length) {
      const id = key('changes');
      push(id, { type: 'changes', turn });
      if (expanded.has(id)) turn.diffs.forEach((file, index) => {
        push(key('diff', file.file, String(index)), { type: 'diff', file });
      });
    }
    // A stable final row also anchors initial readiness for empty/working turns.
    push(key('meta'), { type: 'meta', turn });
    return rows;
  });
}
