import { QueryClient } from '@tanstack/react-query';

/** Native calls already own reconnects and retries; query reads follow their lifecycle. */
export const appQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      networkMode: 'always',
      gcTime: 60_000,
      structuralSharing: false,
    },
  },
});
