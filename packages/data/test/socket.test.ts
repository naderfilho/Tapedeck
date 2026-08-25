/**
 * The adapter over the platform's `WebSocket`.
 *
 * It is four lines of wiring per event, and every one of them is somewhere a mistake would be
 * invisible until a live session behaved oddly at three in the morning. The global is swapped for
 * a stub here, so the mapping — text frames only, a close code turned into a readable reason, a
 * second `close()` doing nothing — is checked without a network.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@tapedeck/core';
import { nodeSocketFactory } from '../src/index.ts';

type Listener = (event: never) => void;

class StubWebSocket {
  static last: StubWebSocket | null = null;
  readonly listeners = new Map<string, Listener[]>();
  readonly url: string;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    StubWebSocket.last = this;
  }

  addEventListener(type: string, handler: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closeCalls++;
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) (handler as (e: unknown) => void)(event);
  }
}

const globals = globalThis as { WebSocket?: unknown };
const original = globals.WebSocket;

afterEach(() => {
  globals.WebSocket = original;
});

describe('the platform socket adapter', () => {
  it('forwards open, text messages and close', () => {
    globals.WebSocket = StubWebSocket;
    const socket = nodeSocketFactory('wss://example.test/stream');
    const seen: string[] = [];
    socket.onOpen(() => seen.push('open'));
    socket.onMessage((data) => seen.push(`message:${data}`));
    socket.onClose((reason) => seen.push(`close:${reason}`));
    socket.onError((error) => seen.push(`error:${error}`));

    const stub = StubWebSocket.last;
    expect(stub?.url).toBe('wss://example.test/stream');
    stub?.emit('open', undefined);
    stub?.emit('message', { data: 'hello' });
    // Binary frames are not something these venues send; passing one to a JSON parser would be a
    // crash in the middle of a live session, so it is dropped here.
    stub?.emit('message', { data: new Uint8Array([1, 2]) });
    stub?.emit('error', {});
    stub?.emit('close', { code: 1006, reason: 'abnormal' });

    expect(seen).toEqual(['open', 'message:hello', 'error:socket error', 'close:1006 abnormal']);
  });

  it('trims a close event that carries no reason', () => {
    globals.WebSocket = StubWebSocket;
    const socket = nodeSocketFactory('wss://example.test');
    let reason = '';
    socket.onClose((value) => {
      reason = value;
    });
    StubWebSocket.last?.emit('close', { code: 1000, reason: '' });
    expect(reason).toBe('1000');
  });

  it('closes once, however many times it is asked', () => {
    globals.WebSocket = StubWebSocket;
    const socket = nodeSocketFactory('wss://example.test');
    socket.close();
    socket.close();
    expect(StubWebSocket.last?.closeCalls).toBe(1);
  });

  it('says what is missing on a runtime with no WebSocket', () => {
    globals.WebSocket = undefined;
    expect(() => nodeSocketFactory('wss://example.test')).toThrow(ConfigError);
    expect(() => nodeSocketFactory('wss://example.test')).toThrow(/Node 24 or newer/);
  });
});
