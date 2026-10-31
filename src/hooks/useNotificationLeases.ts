import { useEffect } from 'react';
import { observeNotificationConsumer } from '../services/notificationConsumer';

/** React only attaches the local consumer; Rust owns registrations and renewals. */
export function useNotificationLeases(enabled: boolean): void {
  useEffect(() => observeNotificationConsumer(enabled), [enabled]);
}
