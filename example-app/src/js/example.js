import { Capacitor } from '@capacitor/core';
import { CapacitorSocketIO } from '@zenzig/capacitor-socket-io';

const CORE_EVENTS = Object.freeze([
    'connect',
    'disconnect',
    'connect_error',
    'connect_timeout',
    'error',
    'message',
    'reconnect',
    'reconnect_attempt',
    'reconnect_error',
    'reconnect_failed',
    'reconnecting',
    'ping',
    'pong',
]);

const CUSTOM_EVENTS = Object.freeze(['broadcast_message', 'presence:update', 'identify:ack']);
const SUBSCRIBED_EVENTS = Object.freeze([...new Set([...CORE_EVENTS, ...CUSTOM_EVENTS])]);

const DEVICE_ID_STORAGE_KEY = 'socketio.example.deviceId';
const DEVICE_ALIAS_STORAGE_KEY = 'socketio.example.deviceAlias';
const AUTH_TOKEN_STORAGE_KEY = 'socketio.example.authToken';
const BROADCAST_HISTORY_LIMIT = 50;
const TIMELINE_LIMIT = 150;
const FALLBACK_PROXY_URL = 'https://socket-proxy.local/';

const listenerHandles = new Map();
const presence = new Map();
const broadcastEntries = [];
const timelineEntries = [];

const appConfig = typeof window !== 'undefined' ? window.APP_CONFIG ?? {} : {};
const state = {
    isProduction: detectProduction(),
    allowSelfSigned: false,
    identity: undefined,
    isConnecting: false,
    socketId: undefined,
    serverUrl: undefined,
    authToken: '',
};

const ui = {};
let isConnected = false;
let pingSequence = 0;

state.identity = loadIdentity();
state.allowSelfSigned = !state.isProduction;
state.authToken = loadAuthToken();

function detectProduction() {
    if (typeof process !== 'undefined' && typeof process.env?.NODE_ENV === 'string') {
        return process.env.NODE_ENV === 'production';
    }

    try {
        const meta = import.meta;
        if (typeof meta?.env?.MODE === 'string') {
            return meta.env.MODE === 'production';
        }
    } catch (error) {
        console.warn('Unable to inspect import.meta.env', error);
    }

    return false;
}

function getPlatformKey() {
    try {
        const platform = typeof Capacitor?.getPlatform === 'function' ? Capacitor.getPlatform() : undefined;
        if (typeof platform === 'string' && platform.length > 0) {
            return platform.toLowerCase();
        }
    } catch (error) {
        console.warn('Unable to determine Capacitor platform', error);
    }

    return 'web';
}

function generateDeviceId(platform) {
    const suffix =
        typeof crypto?.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
    return `${platform}-${suffix}`.toLowerCase();
}

function defaultAlias(platform, deviceId) {
    const label = platform.charAt(0).toUpperCase() + platform.slice(1);
    const suffix = deviceId.slice(-4).toUpperCase();
    return `${label} ${suffix}`;
}

function safeReadStorage(key) {
    try {
        if (typeof localStorage === 'undefined') {
            return undefined;
        }

        return localStorage.getItem(key) ?? undefined;
    } catch (error) {
        console.warn(`Unable to read ${key} from storage`, error);
        return undefined;
    }
}

function safeWriteStorage(key, value) {
    try {
        if (typeof localStorage === 'undefined') {
            return;
        }

        localStorage.setItem(key, value);
    } catch (error) {
        console.warn(`Unable to persist ${key}`, error);
    }
}

function safeRemoveStorage(key) {
    try {
        if (typeof localStorage === 'undefined') {
            return;
        }

        localStorage.removeItem(key);
    } catch (error) {
        console.warn(`Unable to remove ${key}`, error);
    }
}

function loadIdentity() {
    const platform = getPlatformKey();
    let deviceId = safeReadStorage(DEVICE_ID_STORAGE_KEY);
    if (!deviceId) {
        deviceId = generateDeviceId(platform);
        safeWriteStorage(DEVICE_ID_STORAGE_KEY, deviceId);
    }

    let alias = safeReadStorage(DEVICE_ALIAS_STORAGE_KEY);
    if (!alias) {
        alias = defaultAlias(platform, deviceId);
        safeWriteStorage(DEVICE_ALIAS_STORAGE_KEY, alias);
    }

    return { deviceId, alias, origin: platform };
}

function normaliseAuthToken(value) {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function loadAuthToken() {
    const storedToken = normaliseAuthToken(safeReadStorage(AUTH_TOKEN_STORAGE_KEY));
    if (storedToken) {
        return storedToken;
    }

    const configuredToken =
        normaliseAuthToken(appConfig.authToken) ?? normaliseAuthToken(appConfig.socketProxyAuthToken);

    return configuredToken ?? '';
}

function cacheDom() {
    ui.connectionIndicator = document.getElementById('connectionIndicator');
    ui.connectionStatusLabel = document.getElementById('connectionStatusLabel');
    ui.socketIdLabel = document.getElementById('socketIdLabel');
    ui.deviceAliasInput = document.getElementById('deviceAliasInput');
    ui.saveAliasButton = document.getElementById('saveAliasBtn');
    ui.serverUrlInput = document.getElementById('serverUrl');
    ui.authTokenInput = document.getElementById('authToken');
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
    hydrateServerUrl();
    hydrateAliasControls();
    hydrateAuthTokenField();
    hydrateSelfSignedToggle();
    attachUiListeners();
    setConnected(false);
    renderPresenceList();
    renderBroadcastFeed();
    renderTimeline();
}

function hydrateServerUrl() {
    if (!ui.serverUrlInput) {
        return;
    }

    const existingValue = (ui.serverUrlInput.value ?? '').trim();
    const selected = ensureTrailingSlash(existingValue || selectProxyOrigin());
    ui.serverUrlInput.value = selected;
    state.serverUrl = selected;
}

function selectProxyOrigin() {
    const origins = appConfig.socketProxyOrigins ?? {};
    const fallback = ensureTrailingSlash(
        typeof appConfig.fallbackProxyUrl === 'string' ? appConfig.fallbackProxyUrl : FALLBACK_PROXY_URL,
    );

    const canonical = ensureTrailingSlash(origins.default || fallback);
    const platformKey = state.identity.origin ?? 'web';
    const platformSpecific = ensureTrailingSlash(origins[platformKey] || canonical);

    if (platformKey === 'android' && isIpAddress(platformSpecific) && !isIpAddress(canonical)) {
        return canonical;
    }

    return platformSpecific || fallback;
}

function ensureTrailingSlash(value) {
    if (!value) {
        return FALLBACK_PROXY_URL;
    }

    const trimmed = value.trim();
    if (trimmed.endsWith('/')) {
        return trimmed;
    }

    return `${trimmed}/`;
}

function isIpAddress(value) {
    if (typeof value !== 'string') {
        return false;
    }

    const candidate = value.replace(/\/+$/, '').trim();
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(candidate);
}

function hydrateAliasControls() {
    if (!ui.deviceAliasInput) {
        return;
    }

    ui.deviceAliasInput.value = state.identity.alias;
    if (ui.saveAliasButton) {
        ui.saveAliasButton.disabled = true;
    }
}

function hydrateAuthTokenField() {
    if (!ui.authTokenInput) {
        return;
    }

    ui.authTokenInput.value = state.authToken ?? '';
    ui.authTokenInput.placeholder = 'Paste JWT for proxy auth';
}

function hydrateSelfSignedToggle() {
    if (!ui.allowSelfSignedToggle) {
        return;
    }

    ui.allowSelfSignedToggle.checked = state.allowSelfSigned;
    ui.allowSelfSignedToggle.disabled = state.isProduction;
    ui.allowSelfSignedToggle.title = state.isProduction
        ? 'Production builds require trusted certificates.'
        : 'Development helper – only use with mkcert/self-signed proxies.';
}

function attachUiListeners() {
    ui.deviceAliasInput?.addEventListener('input', onAliasInputChange);
    ui.saveAliasButton?.addEventListener('click', saveAlias);
    ui.connectButton?.addEventListener('click', connect);
    ui.disconnectButton?.addEventListener('click', disconnect);
    ui.pingButton?.addEventListener('click', sendPing);
    ui.broadcastButton?.addEventListener('click', sendBroadcast);
    ui.clearTimelineButton?.addEventListener('click', clearTimeline);
    ui.authTokenInput?.addEventListener('input', onAuthTokenInputChange);
    ui.authTokenInput?.addEventListener('blur', persistAuthToken);

    ui.broadcastMessageInput?.addEventListener('input', updateBroadcastButtonState);
    ui.broadcastMessageInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void sendBroadcast();
        }
    });

    ui.serverUrlInput?.addEventListener('blur', () => {
        if (!ui.serverUrlInput) {
            return;
        }

        const nextValue = ensureTrailingSlash(ui.serverUrlInput.value);
        ui.serverUrlInput.value = nextValue;
        state.serverUrl = nextValue;
    });

    ui.allowSelfSignedToggle?.addEventListener('change', () => {
        if (!ui.allowSelfSignedToggle) {
            return;
        }

        state.allowSelfSigned = !!ui.allowSelfSignedToggle.checked;
    });
}

function onAliasInputChange() {
    if (!ui.deviceAliasInput || !ui.saveAliasButton) {
        return;
    }

    const trimmed = ui.deviceAliasInput.value.trim();
    ui.saveAliasButton.disabled = trimmed.length === 0 || trimmed === state.identity.alias;
}

function onAuthTokenInputChange() {
    if (!ui.authTokenInput) {
        return;
    }

    state.authToken = ui.authTokenInput.value;
}

function persistAuthToken(nextValue) {
    let candidate;

    if (typeof nextValue === 'string') {
        candidate = nextValue;
    } else if (typeof nextValue?.target?.value === 'string') {
        candidate = nextValue.target.value;
    } else if (ui.authTokenInput) {
        candidate = ui.authTokenInput.value;
    }

    const trimmed = normaliseAuthToken(candidate ?? '') ?? '';
    state.authToken = trimmed;

    if (ui.authTokenInput && ui.authTokenInput.value !== trimmed) {
        ui.authTokenInput.value = trimmed;
    }

    if (trimmed.length > 0) {
        safeWriteStorage(AUTH_TOKEN_STORAGE_KEY, trimmed);
    } else {
        safeRemoveStorage(AUTH_TOKEN_STORAGE_KEY);
    }
}

function saveAlias() {
    if (!ui.deviceAliasInput || !ui.saveAliasButton) {
        return;
    }

    const trimmed = ui.deviceAliasInput.value.trim();
    const nextAlias = trimmed || defaultAlias(state.identity.origin, state.identity.deviceId);

    state.identity.alias = nextAlias;
    safeWriteStorage(DEVICE_ALIAS_STORAGE_KEY, nextAlias);

    ui.deviceAliasInput.value = nextAlias;
    ui.saveAliasButton.disabled = true;

    addTimelineEntry('identity:alias', { alias: nextAlias });

    if (isConnected) {
        void sendIdentity('alias-updated');
    }
}

function setConnectingState(value) {
    state.isConnecting = value;

    if (!ui.connectButton) {
        return;
    }

    if (value) {
        ui.connectButton.disabled = true;
        ui.connectButton.textContent = 'Connecting…';
        return;
    }

    ui.connectButton.textContent = 'Connect';
    ui.connectButton.disabled = isConnected;
}

function setConnected(value, meta = {}) {
    isConnected = value;
    state.socketId = value ? meta.socketId ?? state.socketId : undefined;

    updateStatusIndicator(value, state.socketId);

    if (ui.connectButton && !state.isConnecting) {
        ui.connectButton.disabled = value;
    }

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

function updateStatusIndicator(connected, socketId) {
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
    ui.broadcastButton.disabled = !isConnected || message.length === 0;
}

function normaliseUrl(value) {
    if (!value || typeof value !== 'string') {
        return ensureTrailingSlash(state.serverUrl ?? selectProxyOrigin());
    }

    const trimmed = value.trim();
    return ensureTrailingSlash(trimmed.length === 0 ? selectProxyOrigin() : trimmed);
}

async function connect() {
    if (isConnected || state.isConnecting) {
        return;
    }

    const targetUrl = normaliseUrl(ui.serverUrlInput?.value);
    state.serverUrl = targetUrl;

    const authToken = normaliseAuthToken(ui.authTokenInput?.value ?? state.authToken) ?? '';
    persistAuthToken(authToken);
    const authPayload = authToken.length > 0 ? { token: authToken } : undefined;
    const queryPayload = authPayload ? { token: authPayload.token } : undefined;

    addTimelineEntry('connect:requested', {
        url: targetUrl,
        allowSelfSigned: state.allowSelfSigned,
        authTokenProvided: authToken.length > 0,
    });

    setConnectingState(true);

    try {
        await CapacitorSocketIO.connect({
            url: targetUrl,
            options: {
                allowSelfSigned: state.allowSelfSigned,
                path: '/socket.io',
                transports: ['websocket'],
                reconnection: true,
                timeout: 10_000,
                auth: authPayload,
                query: queryPayload,
            },
        });
    } catch (error) {
        const details = serialiseError(error);
        addTimelineEntry('connect:error', details);
        setConnectingState(false);
        setConnected(false);
    }
}

async function disconnect() {
    if (!isConnected && !state.isConnecting) {
        return;
    }

    addTimelineEntry('disconnect:requested', {
        socketId: state.socketId,
    });

    try {
        await CapacitorSocketIO.disconnect();
    } catch (error) {
        addTimelineEntry('disconnect:error', serialiseError(error));
    } finally {
        setConnectingState(false);
        setConnected(false);
    }
}

async function sendPing() {
    if (!isConnected) {
        addTimelineEntry('ping:error', { message: 'Connect before sending ping.' });
        return;
    }

    const message = ui.pingMessageInput?.value?.trim() ?? '';
    const payload = {
        deviceId: state.identity.deviceId,
        alias: state.identity.alias,
        origin: state.identity.origin,
        message: message.length > 0 ? message : undefined,
        sequence: ++pingSequence,
        sentAt: new Date().toISOString(),
        socketId: state.socketId,
    };

    addTimelineEntry('ping:sent', payload);

    if (ui.pingResult) {
        ui.pingResult.textContent = 'Ping sent. Waiting for pong…';
        ui.pingResult.className = 'callout callout--info';
    }

    try {
        await CapacitorSocketIO.emit({ event: 'ping', data: payload });
    } catch (error) {
        const details = serialiseError(error);
        addTimelineEntry('ping:error', details);

        if (ui.pingResult) {
            ui.pingResult.textContent = `Ping failed: ${details.message}`;
            ui.pingResult.className = 'callout callout--danger';
        }
    }
}

async function sendBroadcast() {
    if (!isConnected || !ui.broadcastMessageInput) {
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
        socketId: state.socketId,
    };

    addTimelineEntry('broadcast:sent', payload);

    try {
        await CapacitorSocketIO.emit({ event: 'broadcast_message', data: payload });
        ui.broadcastMessageInput.value = '';
        updateBroadcastButtonState();
    } catch (error) {
        addTimelineEntry('broadcast:error', serialiseError(error));
    }
}

function clearTimeline() {
    timelineEntries.length = 0;
    renderTimeline();

    if (ui.pingResult) {
        ui.pingResult.textContent = 'Timeline cleared.';
        ui.pingResult.className = 'callout callout--muted';
    }
}

async function registerEventListeners() {
    await cleanupListeners();

    for (const event of SUBSCRIBED_EVENTS) {
        try {
            await CapacitorSocketIO.on({ event });
            const handle = await CapacitorSocketIO.addListener(event, (payload) => routeEvent(event, payload));
            listenerHandles.set(event, handle);
        } catch (error) {
            addTimelineEntry('listener:error', { event, error: serialiseError(error) });
        }
    }
}

async function cleanupListeners() {
    const removals = Array.from(listenerHandles.values()).map(async (handle) => {
        try {
            await handle?.remove?.();
        } catch (error) {
            console.warn('Failed to remove listener handle', error);
        }
    });

    listenerHandles.clear();

    if (removals.length > 0) {
        await Promise.all(removals);
    }

    try {
        await CapacitorSocketIO.removeAllListeners();
    } catch (error) {
        console.warn('CapacitorSocketIO.removeAllListeners failed', error);
    }
}

function routeEvent(event, payload) {
    switch (event) {
        case 'connect':
            handleConnectEvent(payload);
            break;
        case 'disconnect':
            handleDisconnectEvent(payload);
            break;
        case 'ping':
            handleTransportPing(firstArgument(payload));
            break;
        case 'pong':
            handlePongEvent(firstArgument(payload));
            break;
        case 'broadcast_message':
            handleBroadcastEvent(firstArgument(payload));
            break;
        case 'presence:update':
            handlePresenceEvent(firstArgument(payload));
            break;
        case 'identify:ack':
            handleIdentityAck(firstArgument(payload));
            break;
        case 'connect_error':
        case 'error':
        case 'reconnect_error':
        case 'reconnect_failed':
            addTimelineEntry(event, serialiseError(firstArgument(payload) ?? payload));
            break;
        case 'reconnect':
            addTimelineEntry('reconnect', { attempt: firstArgument(payload) ?? payload });
            void sendIdentity('reconnected');
            break;
        default:
            addTimelineEntry(event, payload?.args ?? []);
            break;
    }
}

function firstArgument(payload) {
    if (!payload || !Array.isArray(payload.args)) {
        return undefined;
    }

    return payload.args[0];
}

function handleConnectEvent(payload) {
    setConnectingState(false);

    const socketId = typeof payload?.id === 'string' ? payload.id : undefined;
    setConnected(true, { socketId });
    addTimelineEntry('connect', { socketId });

    void sendIdentity('connected');
}

function handleDisconnectEvent(payload) {
    setConnectingState(false);
    setConnected(false);

    const reason = payload?.args?.[0] ?? 'unknown';
    addTimelineEntry('disconnect', { reason });
}

function handleTransportPing(body) {
    if (!body || (Array.isArray(body) && body.length === 0)) {
        return;
    }

    if (typeof body === 'object' && Object.keys(body).length === 0) {
        return;
    }

    addTimelineEntry('ping', body);
}

function handlePongEvent(body) {
    const pong = normalisePong(body);
    addTimelineEntry('pong', pong);

    if (ui.pingResult) {
        ui.pingResult.textContent = `Pong from ${pong.originLabel} at ${formatTimestamp(pong.respondedAt)}.`;
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

function handlePresenceEvent(body) {
    const clients = Array.isArray(body?.clients) ? body.clients : [];
    presence.clear();

    for (const client of clients) {
        const normalised = normaliseClient(client);
        presence.set(normalised.deviceId, normalised);
    }

    renderPresenceList();

    if (body?.joined) {
        addTimelineEntry('presence:joined', { deviceId: body.joined });
    }

    if (body?.left) {
        addTimelineEntry('presence:left', { deviceId: body.left, reason: body.reason });
    }
}

function handleIdentityAck(body) {
    if (!body) {
        return;
    }

    addTimelineEntry('identify:ack', body);
}

function snapshotTimelineDetails(details) {
    if (details === undefined) {
        return null;
    }

    if (details === null) {
        return null;
    }

    if (typeof details === 'string' || typeof details === 'number' || typeof details === 'boolean') {
        return details;
    }

    if (typeof details === 'bigint') {
        return details.toString();
    }

    if (details instanceof Date) {
        return details.toISOString();
    }

    if (Array.isArray(details)) {
        return details.map((item) => snapshotTimelineDetails(item));
    }

    if (typeof details === 'object') {
        if (typeof structuredClone === 'function') {
            try {
                return structuredClone(details);
            } catch (error) {
                // Fall through to JSON stringify fallback
            }
        }

        try {
            return JSON.parse(JSON.stringify(details));
        } catch (error) {
            const clone = {};
            let hasOwnProperty = false;

            for (const key of Reflect.ownKeys(details)) {
                if (typeof key === 'string') {
                    hasOwnProperty = true;
                    try {
                        clone[key] = snapshotTimelineDetails(details[key]);
                    } catch (innerError) {
                        clone[key] = `[[unserializable: ${String(innerError)}]]`;
                    }
                }
            }

            if (hasOwnProperty) {
                return clone;
            }
        }
    }

    return String(details ?? '');
}

function addTimelineEntry(event, details) {
    const entry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        event,
        details: snapshotTimelineDetails(details),
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
            const subline = escapeHtml(client.deviceId);
            const extras = [];

            if (client.socketId) {
                extras.push(`Socket ID: ${escapeHtml(client.socketId)}`);
            }

            if (typeof client.lastSeen === 'string') {
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
        originLabel: (body.alias ?? body.origin ?? 'Unknown').toString(),
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
        alias: body.alias ?? 'Unknown',
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

async function sendIdentity(reason) {
    if (!isConnected) {
        return;
    }

    const payload = {
        reason,
        deviceId: state.identity.deviceId,
        alias: state.identity.alias,
        origin: state.identity.origin,
        socketId: state.socketId,
        sentAt: new Date().toISOString(),
    };

    addTimelineEntry('identify:send', payload);

    try {
        await CapacitorSocketIO.emit({ event: 'identify', data: payload });
    } catch (error) {
        addTimelineEntry('identify:error', serialiseError(error));
    }
}

function normaliseUrlForDisplay(url) {
    return url?.replace(/\/$/, '') ?? '';
}

async function init() {
    initialiseDom();
    await registerEventListeners();
    setConnected(false);

    addTimelineEntry('ready', {
        message: 'UI initialised. Tap Connect to open the socket.',
        allowSelfSigned: state.allowSelfSigned,
        proxyUrl: normaliseUrlForDisplay(state.serverUrl),
    });

    Object.assign(window, {
        socketIOConnect: connect,
        socketIODisconnect: disconnect,
        socketIOSendPing: sendPing,
        socketIOSendBroadcast: sendBroadcast,
        socketIOClearTimeline: clearTimeline,
    });
}

void init();
