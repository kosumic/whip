const REGISTRATION_FIELD = 'whip_notify_registration';
interface NotificationRegistrationProof {
  device_id: string;
  challenge: string;
}

export function notificationRegistrationProof(
  data: Record<string, unknown> | null | undefined,
): NotificationRegistrationProof | null {
  const value = data?.[REGISTRATION_FIELD];
  if (!value || typeof value !== 'object') return null;
  const proof = value as Partial<NotificationRegistrationProof>;
  return typeof proof.device_id === 'string' &&
    /^[a-zA-Z0-9_-]{16,64}$/.test(proof.device_id) &&
    typeof proof.challenge === 'string' &&
    /^[a-zA-Z0-9_-]{43}$/.test(proof.challenge)
    ? { device_id: proof.device_id, challenge: proof.challenge }
    : null;
}
