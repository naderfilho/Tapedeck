/**
 * The socket seam.
 *
 * Everything above this file deals in {@link StreamSocket}, which has four callbacks and a close
 * button. That is the whole reason the live path is testable: a test hands the stream a fake that
 * replays a recorded frame sequence, and the frames go through the same parsing, the same
 * reconnection logic and the same queue that a real connection would use.
 *
 * The implementation is the platform's own `WebSocket`. Node 24 ships one (ADR-0007 no longer
 * needs the `ws` dependency it reserved for this), so `@tapedeck/data` keeps a single runtime
 * dependency. The global is reached through a narrow structural type rather than the DOM lib,
 * because pulling `lib.dom` into a Node project to name one constructor brings a browser's worth
 * of globals with it.
 */

import { ConfigError } from '@tapedeck/core';

export interface StreamSocket {
  onOpen(handler: () => void): void;
  /** Text frames only. Binary frames are not something the venues used here send. */
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  onError(handler: (error: string) => void): void;
  close(): void;
}

export type SocketFactory = (url: string) => StreamSocket;

interface PlatformSocket {
  addEventListener(type: 'open', handler: () => void): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', handler: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: 'error', handler: (event: unknown) => void): void;
  close(code?: number): void;
}

type PlatformSocketConstructor = new (url: string) => PlatformSocket;

/** Wraps the runtime's `WebSocket`. The only place in the package that touches a real socket. */
export const nodeSocketFactory: SocketFactory = (url: string): StreamSocket => {
  const Impl = (globalThis as { WebSocket?: PlatformSocketConstructor }).WebSocket;
  if (Impl === undefined) {
    throw new ConfigError(
      'this runtime has no global WebSocket; Tapedeck paper trading needs Node 24 or newer',
    );
  }
  const socket = new Impl(url);
  let closed = false;

  return {
    onOpen: (handler) => {
      socket.addEventListener('open', handler);
    },
    onMessage: (handler) => {
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') handler(event.data);
      });
    },
    onClose: (handler) => {
      socket.addEventListener('close', (event) => {
        handler(`${String(event.code)} ${event.reason}`.trim());
      });
    },
    onError: (handler) => {
      socket.addEventListener('error', () => {
        // The event carries no usable detail in Node's implementation; a close event follows and
        // carries the code, so this exists to keep an error from being an unhandled event.
        handler('socket error');
      });
    },
    close: () => {
      if (closed) return;
      closed = true;
      socket.close();
    },
  };
};
