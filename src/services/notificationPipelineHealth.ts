// Readiness is also gated by setup, permission, consumer attachment and runtime health.
let available = true;
export function notificationDeliveryAvailable(): boolean {
  return available;
}
export function setNotificationDeliveryAvailable(value: boolean): void {
  available = value;
}
