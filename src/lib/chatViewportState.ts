export const CHAT_VIEWPORT_CAPACITY = 2;
export const PRIORITY_CHAT_VIEWPORT_CAPACITY = 3;

/** Small UI checkpoint; never holds transcript contents or native resources. */
export interface ChatViewportState {
  offset: number;
  followEnd: boolean;
  expandedBlocks: ReadonlySet<string>;
  anchor?: { blockId: string; offset: number };
}
