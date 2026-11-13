import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';

import { CapacitorSocketIOWeb, DEFAULT_ACK_TIMEOUT_MS } from '../src/web';

// Commit 7: emitWithAck on web, against a real local socket.io server (no mocks of the client).

const SECRET = 'tok-SECRET-123';
let httpServer;
let io;
let url;
const handshakes = [];
const settleCounts = new Map();

beforeAll(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { cors: { origin: '*' } });
  io.on('connection', socket => {
    handshakes.push({ auth: socket.handshake.auth, requestUrl: socket.request.url });
    socket.on('echo', (payload, ack) => ack?.(payload));
    socket.on('multi', (a, ack) => ack?.(a, { second: true }, 3));
    socket.on('noargs', (ack) => ack?.());
    socket.on('never', () => {});
    socket.on('late', (ms, ack) => setTimeout(() => ack?.('late-value'), ms));
    socket.on('kick', () => socket.disconnect(true));
    socket.on('count', (key, ack) => {
      settleCounts.set(key, (settleCounts.get(key) ?? 0) + 1);
      ack?.(settleCounts.get(key));
    });
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${httpServer.address().port}/`;
});

afterAll(async () => {
  await new Promise(resolve => io.close(() => resolve()));
});

/** Connects a fresh web plugin and waits for the real `connect` event. */
async function connected(options = {}) {
  const plugin = new CapacitorSocketIOWeb();
  const up = new Promise(resolve => plugin.addListener('connect', resolve));
  await plugin.connect({ url, options: { transports: ['websocket'], reconnection: false, ...options } });
  await up;
  return plugin;
}

const plugins = [];
const open = async options => {
  const plugin = await connected(options);
  plugins.push(plugin);
  return plugin;
};
afterEach(async () => {
  while (plugins.length) await plugins.pop().disconnect();
});

/** Resolves with the rejection value, or fails if the promise resolves. */
const rejection = async promise => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection but the promise resolved');
};

describe('web emitWithAck', () => {
  it('resolves {args} with the ack payload for a data emit', async () => {
    const plugin = await open();
    const result = await plugin.emitWithAck({ event: 'echo', data: { a: 1 }, timeoutMs: 3000 });
    expect(result).toEqual({ args: [{ a: 1 }] });
  });

  it('forwards args verbatim (args win over data) and returns every ack argument', async () => {
    const plugin = await open();
    const result = await plugin.emitWithAck({ event: 'multi', args: ['x'], data: { ignored: true }, timeoutMs: 3000 });
    expect(result).toEqual({ args: ['x', { second: true }, 3] });
  });

  it('resolves an empty args array when the server acks with nothing', async () => {
    const plugin = await open();
    expect(await plugin.emitWithAck({ event: 'noargs', timeoutMs: 3000 })).toEqual({ args: [] });
  });

  it('rejects ACK_TIMEOUT when the server never acks', async () => {
    const plugin = await open();
    const started = Date.now();
    const error = await rejection(plugin.emitWithAck({ event: 'never', timeoutMs: 150 }));
    expect(error.code).toBe('ACK_TIMEOUT');
    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeGreaterThanOrEqual(130);
  });

  it('sends the event once: a timeout does not re-emit', async () => {
    const plugin = await open();
    settleCounts.delete('once');
    await plugin.emitWithAck({ event: 'count', args: ['once'], timeoutMs: 2000 });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(settleCounts.get('once')).toBe(1);
  });

  it('settles once: an ack that arrives after the timeout is ignored', async () => {
    const plugin = await open();
    const error = await rejection(plugin.emitWithAck({ event: 'late', args: [300], timeoutMs: 100 }));
    expect(error.code).toBe('ACK_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 400)); // the late ack lands here; no throw, no unhandled rejection
  });

  it('rejects NOT_CONNECTED before connect() was ever called', async () => {
    const plugin = new CapacitorSocketIOWeb();
    const error = await rejection(plugin.emitWithAck({ event: 'echo', data: {}, timeoutMs: 100 }));
    expect(error.code).toBe('NOT_CONNECTED');
  });

  it('rejects NOT_CONNECTED after disconnect()', async () => {
    const plugin = await open();
    await plugin.disconnect();
    const error = await rejection(plugin.emitWithAck({ event: 'echo', data: {}, timeoutMs: 100 }));
    expect(error.code).toBe('NOT_CONNECTED');
  });

  it('rejects NOT_CONNECTED when the socket drops while the ack is pending', async () => {
    const plugin = await open();
    const pending = plugin.emitWithAck({ event: 'never', timeoutMs: 5000 });
    plugin.emit({ event: 'kick' });
    const error = await rejection(pending);
    expect(error.code).toBe('NOT_CONNECTED');
  });

  it('rejects INVALID_ARGUMENT for a missing or blank event', async () => {
    const plugin = await open();
    for (const event of [undefined, '', '   ']) {
      const error = await rejection(plugin.emitWithAck({ event, timeoutMs: 100 }));
      expect(error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('rejects INVALID_ARGUMENT for a bad timeoutMs and does not emit', async () => {
    const plugin = await open();
    settleCounts.delete('bad-timeout');
    for (const timeoutMs of [0, -5, '100', Number.NaN, Infinity, {}]) {
      const error = await rejection(plugin.emitWithAck({ event: 'count', args: ['bad-timeout'], timeoutMs }));
      expect(error.code, `timeoutMs=${String(timeoutMs)}`).toBe('INVALID_ARGUMENT');
    }
    expect(settleCounts.get('bad-timeout')).toBeUndefined();
  });

  it('uses a 10 s default when timeoutMs is omitted', async () => {
    expect(DEFAULT_ACK_TIMEOUT_MS).toBe(10_000);
    const plugin = await open();
    expect(await plugin.emitWithAck({ event: 'echo', data: { d: 1 } })).toEqual({ args: [{ d: 1 }] });
  });

  it('keeps the credential out of the URL: it rides in handshake.auth only', async () => {
    handshakes.length = 0;
    const plugin = await open({ auth: { token: SECRET } });
    expect(await plugin.emitWithAck({ event: 'echo', data: { z: 1 }, timeoutMs: 3000 })).toEqual({ args: [{ z: 1 }] });
    const handshake = handshakes.at(-1);
    expect(handshake.auth).toEqual({ token: SECRET });
    expect(handshake.requestUrl).not.toContain(SECRET);
    expect(handshake.requestUrl).not.toContain('token=');
  });
});
