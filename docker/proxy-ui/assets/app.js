const DEVICE_ID_STORAGE_KEY = 'socketio.proxy.deviceId';
const DEVICE_ALIAS_STORAGE_KEY = 'socketio.proxy.alias';
const ALLOW_SELF_SIGNED_STORAGE_KEY = 'socketio.proxy.allowSelfSigned';
const BROADCAST_HISTORY_LIMIT = 50;
const TIMELINE_LIMIT = 150;

const broadcastEntries = [];
const timelineEntries = [];
const presence = new Map();

const state = {
  socket: null,
  isConnecting: false,
  connected: false,
  pingSequence: 0,
  serverUrl: window.location.origin,
  allowSelfSigned: loadAllowSelfSigned(),
  identity: loadIdentity(),
};

const ui = {};

function loadIdentity() {
  const origin = 'web';
  const storedId = safeReadStorage(DEVICE_ID_STORAGE_KEY);
  const storedAlias = safeReadStorage(DEVICE_ALIAS_STORAGE_KEY);
  const deviceId = storedId ?? generateDeviceId(origin);
  const alias = storedAlias ?? defaultAlias(origin, deviceId);

  if (!storedId) {
    safeWriteStorage(DEVICE_ID_STORAGE_KEY, deviceId);
  }

  if (!storedAlias) {
    safeWriteStorage(DEVICE_ALIAS_STORAGE_KEY, alias);
  }

  return { deviceId, alias, origin };
}

function loadAllowSelfSigned() {
  const stored = safeReadStorage(ALLOW_SELF_SIGNED_STORAGE_KEY);
  return stored === 'true';
}

function safeReadStorage(key) {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch (error) {
    console.warn('storage read error', error);
    return undefined;
  }
}

function safeWriteStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn('storage write error', error);
  }
}

function generateDeviceId(origin) {
  if (typeof crypto?.randomUUID === 'function') {
    return `${origin}-${crypto.randomUUID()}`.toLowerCase();
  }

  return `${origin}-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`.toLowerCase();
}

function defaultAlias(origin, deviceId) {
  const label = origin.charAt(0).toUpperCase() + origin.slice(1);
  const suffix = deviceId.slice(-4).toUpperCase();
  return `${label} ${suffix}`;
}

function cacheDom() {
  ui.connectionIndicator = document.getElementById('connectionIndicator');
  ui.connectionStatusLabel = document.getElementById('connectionStatusLabel');
  ui.socketIdLabel = document.getElementById('socketIdLabel');
  ui.deviceAliasInput = document.getElementById('deviceAliasInput');
  ui.saveAliasButton = document.getElementById('saveAliasBtn');
  ui.serverUrlInput = document.getElementById('serverUrl');
  ui.allowSelfSignedToggle = document.getElementById('allowSelfSigned');
  ui.connectButton = document.getElementById('connectBtn');
  ui.disconnectButton = document.getElementById('disconnectBtn');
  ui.pingMessageInput = document.getElementById('pingMessage');
  ui.pingButton = document.getElementById('pingBtn');
  ui.pingResult = document.getElementById('pingResult');
  ui.broadcastMessageInput = document.getElementById('broadcastMessage');
  ui.broadcastButton = document.getElementById('broadcastBtn');
  ui.broadcastFeed = document.getElementById('broadcastFeed');
  ui.presenceList = document.getElementById('presenceList');
  ui.timeline = document.getElementById('timeline');
  ui.clearTimelineButton = document.getElementById('clearTimelineBtn');
}

function initialiseDom() {
  cacheDom();
  hydrateAliasControls();
  hydrateServerUrl();
  hydrateAllowSelfSigned();
  attachUiListeners();
  renderBroadcastFeed();
  renderPresenceList();
  renderTimeline();
  updateStatusIndicator(false);
}

function hydrateAliasControls() {
  if (!ui.deviceAliasInput || !ui.saveAliasButton) {
    return;
  }

  ui.deviceAliasInput.value = state.identity.alias;
  ui.saveAliasButton.disabled = true;
}

function hydrateServerUrl() {
  if (!ui.serverUrlInput) {
    return;
  }

  const value = ui.serverUrlInput.value?.trim();
  ui.serverUrlInput.value =
    value && value.length > 0 ? ensureTrailingSlash(value) : ensureTrailingSlash(state.serverUrl);
  state.serverUrl = ui.serverUrlInput.value;
}

function hydrateAllowSelfSigned() {
  if (!ui.allowSelfSignedToggle) {
    return;
  }

  ui.allowSelfSignedToggle.checked = state.allowSelfSigned;
  ui.allowSelfSignedToggle.title =
    'This mirrors the native apps. Browsers still require you to trust the certificate manually.';
}

function attachUiListeners() {
  ui.deviceAliasInput?.addEventListener('input', onAliasInputChange);
  ui.saveAliasButton?.addEventListener('click', saveAlias);
  ui.connectButton?.addEventListener('click', connect);
  ui.disconnectButton?.addEventListener('click', disconnect);
  ui.pingButton?.addEventListener('click', sendPing);
  ui.broadcastButton?.addEventListener('click', sendBroadcast);
  ui.clearTimelineButton?.addEventListener('click', clearTimeline);
  ui.allowSelfSignedToggle?.addEventListener('change', onAllowSelfSignedChanged);

  ui.serverUrlInput?.addEventListener('blur', () => {
    if (!ui.serverUrlInput) {
      return;
    }

    const nextValue = ensureTrailingSlash(ui.serverUrlInput.value);
    ui.serverUrlInput.value = nextValue;
    state.serverUrl = nextValue;
  });

  ui.broadcastMessageInput?.addEventListener('input', updateBroadcastButtonState);
  ui.broadcastMessageInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendBroadcast();
    }
  });
}

function ensureTrailingSlash(value) {
  if (!value) {
    return `${window.location.origin}/`;
  }

  const trimmed = value.toString().trim();
  if (trimmed.endsWith('/')) {
    return trimmed;
  }

  return `${trimmed}/`;
}

function onAllowSelfSignedChanged(event) {
  const checked = !!event.target.checked;
  state.allowSelfSigned = checked;
  safeWriteStorage(ALLOW_SELF_SIGNED_STORAGE_KEY, String(checked));
  addTimelineEntry('config:allowSelfSigned', { allowSelfSigned: checked });
}

function onAliasInputChange() {
  if (!ui.deviceAliasInput || !ui.saveAliasButton) {
    return;
  }

  const trimmed = ui.deviceAliasInput.value.trim();
  ui.saveAliasButton.disabled = trimmed.length === 0 || trimmed === state.identity.alias;
}

function saveAlias() {
  if (!ui.deviceAliasInput || !ui.saveAliasButton) {
    return;
  }

  const trimmed = ui.deviceAliasInput.value.trim();
  const alias = trimmed.length > 0 ? trimmed : defaultAlias(state.identity.origin, state.identity.deviceId);

  state.identity.alias = alias;
  ui.deviceAliasInput.value = alias;
  ui.saveAliasButton.disabled = true;
  safeWriteStorage(DEVICE_ALIAS_STORAGE_KEY, alias);
  addTimelineEntry('identity:alias', { alias });

  if (state.connected) {
    sendIdentity('alias-updated');
  }
}

function setConnecting(value) {
  state.isConnecting = value;

  if (!ui.connectButton) {
    return;
  }

  if (value) {
    ui.connectButton.disabled = true;
    ui.connectButton.textContent = 'Connecting…';
  } else {
    ui.connectButton.textContent = 'Connect';
    ui.connectButton.disabled = state.connected;
  }
}

function setConnected(value) {
  state.connected = value;
  updateStatusIndicator(value);

  if (ui.disconnectButton) {
    ui.disconnectButton.disabled = !value;
  }

  if (ui.pingButton) {
    ui.pingButton.disabled = !value;
  }

  updateBroadcastButtonState();

  if (!value) {
    presence.clear();
    renderPresenceList();
  }
}

function updateStatusIndicator(connected, socketId = state.socket?.id) {
  if (!ui.connectionIndicator || !ui.connectionStatusLabel || !ui.socketIdLabel) {
    return;
  }

  ui.connectionIndicator.classList.toggle('status__dot--online', connected);
  ui.connectionIndicator.classList.toggle('status__dot--offline', !connected);
  ui.connectionStatusLabel.textContent = connected ? 'Connected' : 'Disconnected';
  ui.socketIdLabel.textContent = connected && socketId ? `Socket ID: ${socketId}` : 'No active socket.';
}

function updateBroadcastButtonState() {
  if (!ui.broadcastButton) {
    return;
  }

  const message = ui.broadcastMessageInput?.value?.trim() ?? '';
  ui.broadcastButton.disabled = !state.connected || message.length === 0;
}

function connect() {
  if (state.connected || state.isConnecting) {
    return;
  }

  if (state.socket) {
    state.socket.off();
    state.socket.disconnect();
    state.socket = null;
  }

  const targetUrl = ensureTrailingSlash(ui.serverUrlInput?.value ?? state.serverUrl);
  state.serverUrl = targetUrl;

  addTimelineEntry('connect:requested', { url: targetUrl, allowSelfSigned: state.allowSelfSigned });
  setConnecting(true);

  const socket = window.io(targetUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
  });

  state.socket = socket;
  wireSocket(socket);
}

function wireSocket(socket) {
  socket.on('connect', () => {
    setConnecting(false);
    setConnected(true);
    updateStatusIndicator(true, socket.id);
    addTimelineEntry('connect', { socketId: socket.id });
    sendIdentity('connected');
  });

  socket.on('disconnect', (reason) => {
    setConnecting(false);
    setConnected(false);
    addTimelineEntry('disconnect', { reason });
  });

  socket.on('connect_error', (error) => {
    setConnecting(false);
    setConnected(false);
    addTimelineEntry('connect_error', serialiseError(error));
  });

  socket.on('reconnect', (attempt) => {
    addTimelineEntry('reconnect', { attempt });
    sendIdentity('reconnected');
  });

  socket.on('reconnect_attempt', (attempt) => {
    addTimelineEntry('reconnect_attempt', { attempt });
  });

  socket.on('reconnect_failed', () => {
    addTimelineEntry('reconnect_failed', { message: 'Maximum reconnect attempts reached.' });
  });

  socket.on('reconnect_error', (error) => {
    addTimelineEntry('reconnect_error', serialiseError(error));
  });

  socket.on('error', (error) => {
    addTimelineEntry('error', serialiseError(error));
  });

  socket.on('pong', (payload) => handlePongEvent(payload));
  socket.on('broadcast_message', (payload) => handleBroadcastEvent(payload));
  socket.on('presence:update', (payload) => handlePresenceEvent(payload));
  socket.on('identify:ack', (payload) => handleIdentityAck(payload));
}

function disconnect() {
  if (!state.socket) {
    return;
  }

  addTimelineEntry('disconnect:requested', { socketId: state.socket.id });
  state.socket.disconnect();
  setConnecting(false);
  setConnected(false);
}

function sendPing() {
  if (!state.connected || !state.socket) {
    addTimelineEntry('ping:error', { message: 'Connect before sending ping.' });
    return;
  }

  const message = ui.pingMessageInput?.value?.trim() ?? '';
  const payload = {
    deviceId: state.identity.deviceId,
    alias: state.identity.alias,
    origin: state.identity.origin,
    message: message.length > 0 ? message : undefined,
    sequence: ++state.pingSequence,
    sentAt: new Date().toISOString(),
    socketId: state.socket.id,
  };

  addTimelineEntry('ping', payload);

  if (ui.pingResult) {
    ui.pingResult.textContent = 'Ping sent. Waiting for pong…';
    ui.pingResult.className = 'callout callout--info';
  }

  state.socket.emit('ping', payload, (ack) => {
    if (ack?.status !== 'ok' && ui.pingResult) {
      ui.pingResult.textContent = `Ping ack: ${JSON.stringify(ack)}`;
      ui.pingResult.className = 'callout callout--muted';
    }
  });
}

function sendBroadcast() {
  if (!state.connected || !state.socket || !ui.broadcastMessageInput) {
    return;
  }

  const message = ui.broadcastMessageInput.value.trim();
  if (!message) {
    updateBroadcastButtonState();
    return;
  }

  const payload = {
    deviceId: state.identity.deviceId,
    alias: state.identity.alias,
    origin: state.identity.origin,
    message,
    sentAt: new Date().toISOString(),
    socketId: state.socket.id,
  };

  addTimelineEntry('broadcast:sent', payload);

  state.socket.emit('broadcast_message', payload, () => {
    ui.broadcastMessageInput.value = '';
    updateBroadcastButtonState();
  });
}

function clearTimeline() {
  timelineEntries.length = 0;
  renderTimeline();
}

function handlePongEvent(body) {
  const pong = normalisePong(body);
  addTimelineEntry('pong', pong);

  if (ui.pingResult) {
    ui.pingResult.textContent = `Pong from ${pong.alias ?? pong.deviceId} at ${formatTimestamp(pong.respondedAt)}.`;
    ui.pingResult.className = 'callout callout--success';
  }
}

function handleBroadcastEvent(body) {
  const message = normaliseBroadcast(body);
  broadcastEntries.unshift(message);

  if (broadcastEntries.length > BROADCAST_HISTORY_LIMIT) {
    broadcastEntries.length = BROADCAST_HISTORY_LIMIT;
  }

  renderBroadcastFeed();
  addTimelineEntry('broadcast_message', message);
}

function handlePresenceEvent(payload = {}) {
  const clients = Array.isArray(payload.clients) ? payload.clients : [];
  presence.clear();

  for (const client of clients) {
    const normalised = normaliseClient(client);
    presence.set(normalised.deviceId, normalised);
  }

  renderPresenceList();

  if (payload.joined) {
    addTimelineEntry('presence:joined', { deviceId: payload.joined });
  }

  if (payload.left) {
    addTimelineEntry('presence:left', { deviceId: payload.left, reason: payload.reason });
  }
}

function handleIdentityAck(payload) {
  if (!payload) {
    return;
  }

  addTimelineEntry('identify:ack', payload);
}

function addTimelineEntry(event, details) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    event,
    details,
    timestamp: new Date().toISOString(),
  };

  timelineEntries.unshift(entry);
  if (timelineEntries.length > TIMELINE_LIMIT) {
    timelineEntries.length = TIMELINE_LIMIT;
  }

  renderTimeline();
}

function renderBroadcastFeed() {
  if (!ui.broadcastFeed) {
    return;
  }

  if (broadcastEntries.length === 0) {
    ui.broadcastFeed.innerHTML = '<li class="feed__empty">No broadcast messages yet.</li>';
    return;
  }

  const items = broadcastEntries
    .map((entry) => {
      const time = formatTimestamp(entry.sentAt);
      const badge = renderOriginBadge(entry.origin);
      const sender = escapeHtml(entry.alias ?? entry.deviceId);
      const message = escapeHtml(entry.message ?? '');

      return `
        <li class="feed__item">
          <div class="feed__header">
            <span class="badge ${badge.className}">${badge.label}</span>
            <strong>${sender}</strong>
            <span class="feed__time">${time}</span>
          </div>
          <div class="feed__message">${message || '<em>No message provided.</em>'}</div>
        </li>
      `;
    })
    .join('');

  ui.broadcastFeed.innerHTML = items;
}

function renderPresenceList() {
  if (!ui.presenceList) {
    return;
  }

  if (presence.size === 0) {
    ui.presenceList.innerHTML = '<li class="presence-list__empty">No other clients are connected.</li>';
    return;
  }

  const list = Array.from(presence.values())
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((client) => {
      const badge = renderOriginBadge(client.origin);
      const alias = escapeHtml(client.alias);
      const extras = [];

      if (client.socketId) {
        extras.push(`Socket ID: ${escapeHtml(client.socketId)}`);
      }

      if (client.lastSeen) {
        extras.push(`Last seen ${formatTimestamp(client.lastSeen)}`);
      }

      const meta = extras.length > 0 ? `<span class="presence-list__meta">${extras.join(' · ')}</span>` : '';

      return `
        <li class="presence-list__item">
          <div class="presence-list__header">
            <span class="badge ${badge.className}">${badge.label}</span>
            <strong>${alias}</strong>
          </div>
          ${meta}
        </li>
      `;
    })
    .join('');

  ui.presenceList.innerHTML = list;
}

function renderTimeline() {
  if (!ui.timeline) {
    return;
  }

  if (timelineEntries.length === 0) {
    ui.timeline.innerHTML = '';
    return;
  }

  const contents = timelineEntries
    .map((entry) => {
      const time = formatTimestamp(entry.timestamp);
      const payload = escapeHtml(JSON.stringify(entry.details, null, 2));

      return `
        <li class="timeline__item">
          <div class="timeline__header">
            <span class="timeline__event">${escapeHtml(entry.event)}</span>
            <span class="timeline__time">${time}</span>
          </div>
          <pre class="timeline__payload">${payload}</pre>
        </li>
      `;
    })
    .join('');

  ui.timeline.innerHTML = contents;
}

function renderOriginBadge(origin) {
  switch (origin) {
    case 'android':
      return { label: 'Android', className: 'badge--android' };
    case 'ios':
      return { label: 'iOS', className: 'badge--ios' };
    case 'web':
      return { label: 'Web', className: 'badge--web' };
    default:
      return { label: origin ?? 'Unknown', className: 'badge--unknown' };
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(isoString) {
  if (!isoString) {
    return 'unknown time';
  }

  try {
    return new Date(isoString).toLocaleString();
  } catch (error) {
    return isoString;
  }
}

function normalisePong(body) {
  if (!body || typeof body !== 'object') {
    return { raw: body };
  }

  return {
    deviceId: body.deviceId ?? 'unknown',
    alias: body.alias ?? 'Unknown',
    origin: body.origin ?? 'unknown',
    message: body.message,
    sequence: body.sequence,
    respondedAt: body.respondedAt ?? body.sentAt ?? new Date().toISOString(),
    latencyMs: typeof body.latencyMs === 'number' ? Math.max(0, Math.round(body.latencyMs)) : undefined,
  };
}

function normaliseBroadcast(body) {
  if (!body || typeof body !== 'object') {
    return { message: JSON.stringify(body) };
  }

  return {
    deviceId: body.deviceId ?? 'unknown',
    alias: body.alias ?? 'Unknown client',
    origin: body.origin ?? 'unknown',
    message: body.message ?? '',
    sentAt: body.sentAt ?? new Date().toISOString(),
    socketId: body.socketId,
  };
}

function normaliseClient(client) {
  if (!client || typeof client !== 'object') {
    return {
      deviceId: 'unknown',
      alias: 'Unknown client',
      origin: 'unknown',
      socketId: undefined,
      lastSeen: undefined,
    };
  }

  return {
    deviceId: client.deviceId ?? 'unknown',
    alias: client.alias ?? 'Unknown client',
    origin: client.origin ?? 'unknown',
    socketId: client.socketId,
    lastSeen: client.lastSeen,
  };
}

function serialiseError(error) {
  return {
    message: error?.message ?? String(error),
    stack: error?.stack,
  };
}

function sendIdentity(reason) {
  if (!state.connected || !state.socket) {
    return;
  }

  const payload = {
    reason,
    deviceId: state.identity.deviceId,
    alias: state.identity.alias,
    origin: state.identity.origin,
    socketId: state.socket.id,
    sentAt: new Date().toISOString(),
  };

  addTimelineEntry('identify:send', payload);
  state.socket.emit('identify', payload);
}

function init() {
  if (!window.io) {
    throw new Error('Socket.IO client library failed to load.');
  }

  initialiseDom();
  addTimelineEntry('ready', {
    message: 'Proxy console initialised. Connect to begin streaming events.',
    origin: window.location.origin,
  });
}

init();
