import { createServer } from 'http';
import { Server } from 'socket.io';

const port = Number.parseInt(process.env.SOCKET_SERVER_PORT ?? '4000', 10);
const path = process.env.SOCKET_SERVER_PATH ?? '/socket.io';

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: '*' },
  path,
});

const clients = new Map();

const nowIso = () => new Date().toISOString();

const normaliseIdentity = (socket, payload = {}) => {
  const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : `device-${socket.id}`;
  const alias = typeof payload.alias === 'string' ? payload.alias : `Client ${socket.id.slice(-4)}`;
  const origin = typeof payload.origin === 'string' ? payload.origin : 'unknown';

  return {
    deviceId,
    alias,
    origin,
    socketId: socket.id,
    lastSeen: nowIso(),
  };
};

const readyClients = () =>
  Array.from(clients.values())
    .filter((client) => client.ready)
    .map(({ deviceId, alias, origin, socketId, lastSeen }) => ({ deviceId, alias, origin, socketId, lastSeen }));

const emitPresence = ({ joined, left, reason } = {}) => {
  const payload = {
    clients: readyClients(),
  };

  if (joined) {
    payload.joined = joined;
  }

  if (left) {
    payload.left = left;
  }

  if (reason) {
    payload.reason = reason;
  }

  io.emit('presence:update', payload);
};

io.on('connection', (socket) => {
  console.log(`[upstream] client ${socket.id} connected`);

  clients.set(socket.id, {
    socketId: socket.id,
    connectedAt: nowIso(),
    lastSeen: nowIso(),
    ready: false,
    deviceId: undefined,
    alias: undefined,
    origin: undefined,
  });

  socket.emit('presence:update', { clients: readyClients() });

  socket.on('identify', (payload = {}, ack) => {
    const identity = normaliseIdentity(socket, payload);
    const reason = typeof payload.reason === 'string' ? payload.reason : 'identify';

    clients.set(socket.id, {
      ...identity,
      connectedAt: clients.get(socket.id)?.connectedAt ?? nowIso(),
      lastSeen: nowIso(),
      ready: true,
    });

    const response = {
      status: 'ok',
      reason,
      identity,
      timestamp: nowIso(),
    };

    console.log(`[upstream] identify ${socket.id}`, response);
    socket.emit('identify:ack', response);
    emitPresence({ joined: identity.deviceId });

    if (typeof ack === 'function') {
      ack(response);
    }
  });

  socket.on('ping', (payload = {}, ack) => {
    const identity = clients.get(socket.id);
    if (identity) {
      identity.lastSeen = nowIso();
    }

    const respondedAt = Date.now();
    const sentAt = payload?.sentAt ? Number(new Date(payload.sentAt)) : respondedAt;
    const latencyMs = Number.isFinite(respondedAt - sentAt) ? Math.max(0, respondedAt - sentAt) : undefined;

    const response = {
      deviceId: identity?.deviceId ?? payload?.deviceId,
      alias: identity?.alias ?? payload?.alias,
      origin: identity?.origin ?? payload?.origin,
      message: payload?.message,
      sequence: payload?.sequence,
      sentAt: payload?.sentAt,
      respondedAt: new Date(respondedAt).toISOString(),
      latencyMs,
    };

    console.log('[upstream] ping', { socket: socket.id, response });
    socket.emit('pong', response);

    if (typeof ack === 'function') {
      ack({ status: 'ok', respondedAt: response.respondedAt, latencyMs });
    }
  });

  socket.on('broadcast_message', (payload = {}, ack) => {
    const identity = clients.get(socket.id);
    if (identity) {
      identity.lastSeen = nowIso();
    }

    const message = {
      deviceId: identity?.deviceId ?? payload?.deviceId,
      alias: identity?.alias ?? payload?.alias ?? `Client ${socket.id.slice(-4)}`,
      origin: identity?.origin ?? payload?.origin ?? 'unknown',
      message: payload?.message ?? '',
      sentAt: payload?.sentAt ?? nowIso(),
      socketId: socket.id,
    };

    console.log('[upstream] broadcast_message', message);
    io.emit('broadcast_message', message);

    if (typeof ack === 'function') {
      ack({ status: 'ok', deliveredAt: nowIso() });
    }
  });

  socket.onAny((event, ...args) => {
    if (!['ping', 'broadcast_message', 'identify'].includes(event)) {
      console.log(`[upstream] event=${event}`, args);
    }
  });

  socket.on('disconnect', (reason) => {
    const identity = clients.get(socket.id);
    clients.delete(socket.id);
    console.log(`[upstream] client ${socket.id} disconnected (${reason})`);

    if (identity?.ready) {
      emitPresence({ left: identity.deviceId, reason });
    }
  });
});

httpServer.listen(port, () => {
  console.log(`Socket.IO upstream listening on http://0.0.0.0:${port}${path}`);
});
