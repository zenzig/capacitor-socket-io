import { createServer } from 'http';
import jwt from 'jsonwebtoken';
import passwordHash from 'pbkdf2-password-hash';
import { Server } from 'socket.io';

const port = Number.parseInt(process.env.SOCKET_SERVER_PORT ?? '4000', 10);
const path = process.env.SOCKET_SERVER_PATH ?? '/socket.io';

const authPassphrase = process.env.SOCKET_SERVER_AUTH_PASSPHRASE;
const authSecretOverride = process.env.SOCKET_SERVER_AUTH_SECRET;
const authSalt = process.env.SOCKET_SERVER_AUTH_SALT ?? 'socket-proxy-auth-salt';
const authAudience = process.env.SOCKET_SERVER_AUTH_AUDIENCE ?? 'socket-proxy-clients';
const authIssuer = process.env.SOCKET_SERVER_AUTH_ISSUER ?? 'socket-proxy.local';
const authClockTolerance = Number.parseInt(process.env.SOCKET_SERVER_AUTH_CLOCK_TOLERANCE ?? '0', 10);

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: '*' },
  path,
});

const clients = new Map();

const nowIso = () => new Date().toISOString();

const createValidationError = (context, message) => {
  const error = new Error(`${context}: ${message}`);
  error.code = 'ERR_VALIDATION';
  return error;
};

const ensureRecord = (value, context) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw createValidationError(context, 'payload must be an object');
  }

  return value;
};

const ensureString = (record, field, { required = false, maxLength = 256, allowEmpty = false } = {}) => {
  const raw = record[field];

  if (raw == null) {
    if (!required) {
      return undefined;
    }

    throw createValidationError(field, 'value is required');
  }

  if (typeof raw !== 'string') {
    throw createValidationError(field, 'must be a string');
  }

  const trimmed = raw.trim();
  if (!allowEmpty && trimmed.length === 0) {
    if (required) {
      throw createValidationError(field, 'cannot be empty');
    }

    return undefined;
  }

  if (trimmed.length > maxLength) {
    throw createValidationError(field, `must be <= ${maxLength} characters`);
  }

  return trimmed;
};

const ensureNumber = (record, field, { required = false, integer = false, min, max } = {}) => {
  const raw = record[field];

  if (raw == null) {
    if (!required) {
      return undefined;
    }

    throw createValidationError(field, 'value is required');
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw createValidationError(field, 'must be a finite number');
  }

  if (integer && !Number.isInteger(value)) {
    throw createValidationError(field, 'must be an integer');
  }

  if (typeof min === 'number' && value < min) {
    throw createValidationError(field, `must be >= ${min}`);
  }

  if (typeof max === 'number' && value > max) {
    throw createValidationError(field, `must be <= ${max}`);
  }

  return value;
};

const ensureDateString = (record, field, { required = false } = {}) => {
  const value = ensureString(record, field, { required, allowEmpty: false });
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw createValidationError(field, 'must be an ISO-8601 timestamp');
  }

  return new Date(timestamp).toISOString();
};

const validateIdentifyPayload = (rawPayload) => {
  const payload = ensureRecord(rawPayload, 'identify');

  return {
    deviceId: ensureString(payload, 'deviceId', { maxLength: 128 }),
    alias: ensureString(payload, 'alias', { maxLength: 128 }),
    origin: ensureString(payload, 'origin', { maxLength: 256 }),
    reason: ensureString(payload, 'reason', { maxLength: 128 }),
  };
};

const validatePingPayload = (rawPayload) => {
  const payload = ensureRecord(rawPayload, 'ping');

  return {
    deviceId: ensureString(payload, 'deviceId', { maxLength: 128 }),
    alias: ensureString(payload, 'alias', { maxLength: 128 }),
    origin: ensureString(payload, 'origin', { maxLength: 256 }),
    message: ensureString(payload, 'message', { maxLength: 2048 }),
    sequence: ensureNumber(payload, 'sequence', { integer: true }),
    sentAt: ensureDateString(payload, 'sentAt'),
  };
};

const validateBroadcastPayload = (rawPayload) => {
  const payload = ensureRecord(rawPayload, 'broadcast_message');

  return {
    deviceId: ensureString(payload, 'deviceId', { maxLength: 128 }),
    alias: ensureString(payload, 'alias', { maxLength: 128 }),
    origin: ensureString(payload, 'origin', { maxLength: 256 }),
    message: ensureString(payload, 'message', { required: true, maxLength: 2048, allowEmpty: false }),
    sentAt: ensureDateString(payload, 'sentAt'),
  };
};

const computeLatencyMs = (sentAtIso, respondedAtEpoch) => {
  if (!sentAtIso) {
    return undefined;
  }

  const sentAtEpoch = Date.parse(sentAtIso);
  if (!Number.isFinite(sentAtEpoch)) {
    return undefined;
  }

  return Math.max(0, respondedAtEpoch - sentAtEpoch);
};

const handleValidationFailure = (socket, event, error, ack) => {
  const message = error?.message ?? 'Invalid payload';
  console.warn(`[validation] ${event} rejected for ${socket.id}: ${message}`);
  const response = { status: 'error', message };
  socket.emit(`${event}:error`, response);
  if (typeof ack === 'function') {
    ack(response);
  }
};

const normaliseIdentity = (socket, payload = {}) => {
  const deviceId = typeof payload.deviceId === 'string' && payload.deviceId.length > 0 ? payload.deviceId : `device-${socket.id}`;
  const alias = typeof payload.alias === 'string' && payload.alias.length > 0 ? payload.alias : `Client ${socket.id.slice(-4)}`;
  const origin = typeof payload.origin === 'string' && payload.origin.length > 0 ? payload.origin : 'unknown';

  return {
    deviceId,
    alias,
    origin,
    socketId: socket.id,
    lastSeen: nowIso(),
  };
};

const extractToken = (handshake) => {
  const authToken = handshake?.auth?.token;
  if (typeof authToken === 'string' && authToken.trim().length > 0) {
    return authToken.trim();
  }

  const queryToken = handshake?.query?.token;
  if (typeof queryToken === 'string' && queryToken.trim().length > 0) {
    return queryToken.trim();
  }

  const header = handshake?.headers?.authorization;
  if (typeof header === 'string') {
    const matches = header.trim().match(/^Bearer\s+(.+)$/i);
    if (matches?.[1]) {
      return matches[1].trim();
    }
  }

  return undefined;
};

let jwtSecret = authSecretOverride ?? null;
if (!jwtSecret && authPassphrase) {
  jwtSecret = await passwordHash.hash(authPassphrase, authSalt);
}

const authEnabled = Boolean(jwtSecret);

const baseAuthContext = Object.freeze({
  isAuthenticated: false,
  strategy: 'none',
});

const verifyOptions = {};
if (authAudience) {
  verifyOptions.audience = authAudience;
}
if (authIssuer) {
  verifyOptions.issuer = authIssuer;
}
if (Number.isFinite(authClockTolerance) && authClockTolerance > 0) {
  verifyOptions.clockTolerance = authClockTolerance;
}

const authenticateSocket = (socket, next) => {
  if (!authEnabled) {
    const context = { ...baseAuthContext };
    socket.auth = context;
    socket.data.auth = context;
    return next();
  }

  try {
    const token = extractToken(socket.handshake);
    if (!token) {
      throw new Error('Missing authentication token');
    }

    const decoded = jwt.verify(token, jwtSecret, verifyOptions);
    const authContext = {
      isAuthenticated: true,
      strategy: 'jwt',
      subject: decoded.sub ?? null,
      tokenId: decoded.jti ?? null,
      scopes: Array.isArray(decoded.scopes) ? decoded.scopes : [],
      issuedAt: decoded.iat ? new Date(decoded.iat * 1000).toISOString() : undefined,
      expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : undefined,
      issuer: decoded.iss ?? verifyOptions.issuer ?? undefined,
      audience: decoded.aud ?? verifyOptions.audience ?? undefined,
    };

    socket.auth = authContext;
    socket.data.auth = authContext;
    return next();
  } catch (error) {
    console.warn(`[auth] rejecting connection ${socket.id ?? 'unknown'}: ${error.message}`);
    return next(new Error('Unauthorized'));
  }
};

const readyClients = () =>
  Array.from(clients.values())
    .filter((client) => client.ready)
    .map(({ deviceId, alias, origin, socketId, lastSeen, auth }) => ({
      deviceId,
      alias,
      origin,
      socketId,
      lastSeen,
      auth: auth?.subject
        ? {
            subject: auth.subject,
            scopes: Array.isArray(auth.scopes) ? auth.scopes : [],
          }
        : undefined,
    }));

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

io.use(authenticateSocket);

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
    auth: socket.auth ?? baseAuthContext,
  });

  socket.emit('presence:update', { clients: readyClients() });

  socket.on('identify', (payload = {}, ack) => {
    try {
      const validated = validateIdentifyPayload(payload);
      const identity = normaliseIdentity(socket, validated);
      const reason = validated.reason ?? 'identify';

      clients.set(socket.id, {
        ...identity,
        connectedAt: clients.get(socket.id)?.connectedAt ?? nowIso(),
        lastSeen: nowIso(),
        ready: true,
        auth: socket.auth ?? baseAuthContext,
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
    } catch (error) {
      handleValidationFailure(socket, 'identify', error, ack);
    }
  });

  socket.on('ping', (payload = {}, ack) => {
    try {
      const validated = validatePingPayload(payload);
      const identity = clients.get(socket.id);
      if (identity) {
        identity.lastSeen = nowIso();
      }

      const respondedAt = Date.now();
      const latencyMs = computeLatencyMs(validated.sentAt, respondedAt);

      const response = {
        deviceId: identity?.deviceId ?? validated.deviceId ?? `device-${socket.id}`,
        alias: identity?.alias ?? validated.alias ?? `Client ${socket.id.slice(-4)}`,
        origin: identity?.origin ?? validated.origin ?? 'unknown',
        message: validated.message,
        sequence: validated.sequence,
        sentAt: validated.sentAt,
        respondedAt: new Date(respondedAt).toISOString(),
        latencyMs,
      };

      console.log('[upstream] ping', { socket: socket.id, response });
      socket.emit('pong', response);

      if (typeof ack === 'function') {
        ack({ status: 'ok', respondedAt: response.respondedAt, latencyMs });
      }
    } catch (error) {
      handleValidationFailure(socket, 'ping', error, ack);
    }
  });

  socket.on('broadcast_message', (payload = {}, ack) => {
    try {
      const validated = validateBroadcastPayload(payload);
      const identity = clients.get(socket.id);
      if (identity) {
        identity.lastSeen = nowIso();
      }

      const message = {
        deviceId: identity?.deviceId ?? validated.deviceId ?? `device-${socket.id}`,
        alias: identity?.alias ?? validated.alias ?? `Client ${socket.id.slice(-4)}`,
        origin: identity?.origin ?? validated.origin ?? 'unknown',
        message: validated.message,
        sentAt: validated.sentAt ?? nowIso(),
        socketId: socket.id,
      };

      console.log('[upstream] broadcast_message', message);
      io.emit('broadcast_message', message);

      if (typeof ack === 'function') {
        ack({ status: 'ok', deliveredAt: nowIso() });
      }
    } catch (error) {
      handleValidationFailure(socket, 'broadcast_message', error, ack);
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
