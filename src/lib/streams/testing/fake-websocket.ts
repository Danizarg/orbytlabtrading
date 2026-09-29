/**
 * In-memory WebSocket test double for stream tests. Not used by production
 * code. Tests drive the "server" side with serverOpen / serverMessage /
 * serverClose and inspect what the client sent.
 */

import type { WebSocketLike } from '../reconnecting-socket';

export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  /** Most recently constructed socket. */
  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!ws) throw new Error('no FakeWebSocket constructed');
    return ws;
  }

  /** Every frame sent by the client on any socket, parsed as JSON. */
  static allSentJson(): unknown[] {
    return FakeWebSocket.instances.flatMap((ws) => ws.sentJson());
  }

  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError: socket not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  sentJson(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }

  /** Methods of every JSON frame this socket sent. */
  sentMethods(): string[] {
    return this.sentJson().map((m) => String((m as { method?: unknown }).method));
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({ type: 'open' } as Event);
  }

  serverMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    this.onmessage?.({ data: text } as MessageEvent);
  }

  serverBinary(): void {
    this.onmessage?.({ data: new ArrayBuffer(4) } as MessageEvent);
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onerror?.({ type: 'error' } as Event);
    this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent);
  }
}
