export enum ChatDetail {
  Compact = 'compact',
  Detailed = 'detailed',
}

export const DEFAULT_CHAT_DETAIL = ChatDetail.Compact;

export function parseChatDetail(value: unknown): ChatDetail {
  return value === ChatDetail.Detailed ? ChatDetail.Detailed : DEFAULT_CHAT_DETAIL;
}
