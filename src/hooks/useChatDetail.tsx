import { createContext, useContext, useState, type ReactNode } from 'react';
import { DEFAULT_CHAT_DETAIL, type ChatDetail } from '../lib/chatDetail';

interface ChatDetailPreference {
  detail: ChatDetail;
  onChange: (detail: ChatDetail) => void;
}

const ChatDetailContext = createContext<ChatDetailPreference | null>(null);

export function ChatDetailProvider({ children, ...preference }: ChatDetailPreference & { children: ReactNode }) {
  return <ChatDetailContext.Provider value={preference}>{children}</ChatDetailContext.Provider>;
}

export function useChatDetail(): ChatDetailPreference {
  const preference = useContext(ChatDetailContext);
  const [detail, onChange] = useState(DEFAULT_CHAT_DETAIL);
  return preference ?? { detail, onChange };
}
