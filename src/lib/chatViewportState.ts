/** Small UI checkpoint; never holds transcript contents or native resources. */
export interface ChatViewportState {
  offset: number;
  followEnd: boolean;
  expandedBlocks: ReadonlySet<string>;
  anchor?: { blockId: string; offset: number };
}
