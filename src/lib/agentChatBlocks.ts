import type { TranscriptMessage, TranscriptPart, TranscriptToolPart, TranscriptTurn } from '../agentChat';
import { ChatDetail, DEFAULT_CHAT_DETAIL } from './chatDetail';

type BlockContent =
  | { type: 'user'; message: TranscriptMessage }
  | { type: 'part'; part: TranscriptPart; streaming: boolean; nested?: boolean }
  | { type: 'context'; tools: TranscriptToolPart[]; memberIds: string[] }
  | { type: 'activity'; parts: TranscriptPart[]; memberIds: string[]; streaming: boolean }
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
  detail: ChatDetail = DEFAULT_CHAT_DETAIL,
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
    let context: typeof parts = [];
    let activity: typeof parts = [];
    const flushActivity = () => {
      if (!activity.length) return;
      const id = key('activity', activity[0].id);
      push(id, {
        type: 'activity',
        parts: activity.map(item => item.part),
        memberIds: activity.map(item => item.id),
        streaming: activity.some(item => item.id === streamingId),
      });
      for (const item of activity) {
        // Failure details stay reachable without opening the activity summary.
        if (expanded.has(id) || (item.part.type === 'tool' && item.part.state.status === 'error')) {
          push(item.id, {
            type: 'part', part: item.part, streaming: item.id === streamingId, nested: true,
          });
        }
      }
      activity = [];
    };
    const flushContext = () => {
      if (!context.length) return;
      const id = key('context', context[0].id);
      push(id, { type: 'context', tools: context.map(item => item.part as TranscriptToolPart), memberIds: context.map(item => item.id) });
      if (expanded.has(id)) {
        for (const item of context) push(item.id, {
          type: 'part', part: item.part, streaming: false, nested: true,
        });
      }
      context = [];
    };
    for (const item of parts) {
      const compactActivity = detail === ChatDetail.Compact && (
        item.part.type === 'reasoning' || (item.part.type === 'tool'
          && !isQuestionTool(item.part))
      );
      if (compactActivity) {
        activity.push(item);
        continue;
      }
      flushActivity();
      if (item.part.type === 'tool' && item.part.state.status !== 'error'
        && /^(?:read|list|glob|grep)$/i.test(item.part.tool)) {
        context.push(item);
      } else {
        flushContext();
        push(item.id, { type: 'part', part: item.part, streaming: item.id === streamingId });
      }
    }
    flushActivity();
    flushContext();
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

/** Resolve a reading anchor when a detail switch replaces a summary with its rows. */
export function chatDetailAnchor(
  anchor: { blockId: string; offset: number },
  before: readonly ChatBlock[],
  after: readonly ChatBlock[],
): { blockId: string; offset: number } | undefined {
  if (after.some(row => row.id === anchor.blockId)) return anchor;
  const previous = before.find(row => row.id === anchor.blockId);
  const memberIds = previous && 'memberIds' in previous ? previous.memberIds : [anchor.blockId];
  const replacement = after.find(row => memberIds.includes(row.id)
    || ('memberIds' in row && row.memberIds.some(id => memberIds.includes(id))))
    ?? after.find(row => row.turnId === previous?.turnId);
  return replacement ? { blockId: replacement.id, offset: 0 } : undefined;
}
