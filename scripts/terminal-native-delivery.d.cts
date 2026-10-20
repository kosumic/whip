interface Binding { generation: string; reset: boolean; baselinePending: boolean; fullPending: boolean }
interface Entry {
  key: string; identity: string; ready: boolean; generation: string | null; native?: Binding | null;
}
interface Event {
  type: string; generation: string; batchId?: string; fullFrame?: boolean;
  writeMs?: number; base64Ms?: number; visibleMs?: number; tracing?: boolean; traceUi?: boolean;
}
interface Message extends Partial<Event> { op: string; generation: string; key?: string; identity?: string; receiveMs?: number }
type Packet = [string, string, string, string, unknown[], string?];
interface Delivery {
  armTrace(key: string): void;
  bind(key: string, identity: string, generation: string, reset: boolean): void;
  bound(generation: string, success: boolean): void;
  deliver(packet: Packet, tracing: boolean, startedAt?: number): void;
  receive(entry: Entry, value: Event): void;
  gap(entry: Entry): void;
  release(entry: Entry): void;
}
declare function postNativeTerminalMessage(value: Message): boolean;
declare function createNativeTerminalDelivery(options: {
  terminals: Map<string, Entry>;
  call: (key: string, method: string, args: unknown[]) => void;
  post: (value: Message) => boolean;
  report: (value: unknown) => void;
}): Delivery;
declare const api: { postNativeTerminalMessage: typeof postNativeTerminalMessage; createNativeTerminalDelivery: typeof createNativeTerminalDelivery };
export = api;
