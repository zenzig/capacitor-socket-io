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

const serverUrlInput = document.getElementById('serverUrl');
const eventNameInput = document.getElementById('eventName');
const eventPayloadInput = document.getElementById('eventPayload');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const emitBtn = document.getElementById('emitBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const logElement = document.getElementById('eventLog');

const registeredEvents = new Set();
const listenerHandles = new Map();
let isConnected = false;

const formatTime = () => new Date().toLocaleTimeString();

const isProduction = (() => {
    if (typeof process !== 'undefined' && typeof process.env?.NODE_ENV === 'string') {
        return process.env.NODE_ENV === 'production';
    }

    try {
        const meta = import.meta;
        if (typeof meta?.env?.MODE === 'string') {
            return meta.env.MODE === 'production';
        }
    } catch (error) {
        // Some bundlers do not expose import.meta; treat as non-production in that case.
    }

    return false;
})();

const shouldAllowSelfSigned = !isProduction;

const log = (message, data) => {
    const payload = data !== undefined ? ` ${JSON.stringify(data)}` : '';
    logElement.textContent = `[${formatTime()}] ${message}${payload}\n` + logElement.textContent;
};

const setConnected = (value) => {
    if (isConnected === value) {
        return;
    }

    isConnected = value;
    connectBtn.disabled = value;
    disconnectBtn.disabled = !value;
    emitBtn.disabled = !value;

    log('connection:state', {
        connected: value,
        allowSelfSigned: shouldAllowSelfSigned,
    });
};

const cleanupListeners = async () => {
    const removals = Array.from(listenerHandles.values()).map(async (handle) => {
        try {
            await handle?.remove?.();
        } catch (error) {
            console.warn('Failed to remove listener handle', error);
        }
    });

    await Promise.all(removals);
    listenerHandles.clear();
    registeredEvents.clear();

    try {
        await CapacitorSocketIO.removeAllListeners();
    } catch (error) {
        console.warn('CapacitorSocketIO.removeAllListeners failed', error);
    }
};

const ensureEventSubscribed = async (event, attachListener = true) => {
    if (!event) {
        return;
    }

    if (!registeredEvents.has(event)) {
        await CapacitorSocketIO.on({ event });
        registeredEvents.add(event);
    }

    if (!attachListener || listenerHandles.has(event)) {
        return;
    }

    const handle = await CapacitorSocketIO.addListener(event, (payload) => {
        if (event === 'connect') {
            setConnected(true);
        } else if (event === 'disconnect') {
            setConnected(false);
        }

        log(`event:${event}`, payload);
    });

    listenerHandles.set(event, handle);
};

const registerCoreListeners = async () => {
    await Promise.all(CORE_EVENTS.map((event) => ensureEventSubscribed(event)));
};

const parsePayload = (raw) => {
    const trimmed = raw.trim();
    if (!trimmed) {
        return undefined;
    }

    try {
        return JSON.parse(trimmed);
    } catch (error) {
        log('parse:notice', { message: 'Treating payload as a raw string', error: serialiseError(error) });
        return trimmed;
    }
};

const buildEmitOptions = (event, payload) => {
    if (payload === undefined) {
        return { event };
    }

    if (Array.isArray(payload)) {
        return { event, args: payload };
    }

    if (payload !== null && typeof payload === 'object') {
        return { event, data: payload };
    }

    return { event, args: [payload] };
};

const serialiseError = (error) => ({
    message: error?.message ?? String(error),
    stack: error?.stack,
});

const connect = async () => {
    try {
        await ensureEventSubscribed('pong');
        await ensureEventSubscribed('message');

        const url = serverUrlInput.value.trim() || undefined;
        log('connect:request', { url, allowSelfSigned: shouldAllowSelfSigned });

        if (!shouldAllowSelfSigned) {
            log('allowSelfSigned disabled', {
                message:
                    'Self-signed certificates are only trusted in development builds. Ensure your proxy presents a trusted certificate.',
            });
        }

        await CapacitorSocketIO.connect({
            url,
            options: {
                allowSelfSigned: shouldAllowSelfSigned,
                path: '/socket.io',
                transports: ['websocket'],
                reconnection: true,
                timeout: 10000,
            },
        });

        setConnected(true);
    } catch (error) {
        log('connect:error', serialiseError(error));
    }
};

const disconnect = async () => {
    try {
        await CapacitorSocketIO.disconnect();
        setConnected(false);
        log('disconnect:requested');
    } catch (error) {
        log('disconnect:error', serialiseError(error));
    }
};

const emitEvent = async () => {
    const event = eventNameInput.value.trim();
    if (!event) {
        log('emit:error', { message: 'Provide an event name before emitting.' });
        return;
    }

    try {
        await ensureEventSubscribed(event);

        const payload = parsePayload(eventPayloadInput.value);
        log('emit:request', { event, payload });
        await CapacitorSocketIO.emit(buildEmitOptions(event, payload));
    } catch (error) {
        log('emit:error', serialiseError(error));
    }
};

const clearLog = () => {
    logElement.textContent = '';
};

const init = async () => {
    await cleanupListeners();
    await registerCoreListeners();
    setConnected(false);

    connectBtn.addEventListener('click', connect);
    disconnectBtn.addEventListener('click', disconnect);
    emitBtn.addEventListener('click', emitEvent);
    clearLogBtn.addEventListener('click', clearLog);

    // Expose helpers for quick debugging in DevTools.
    Object.assign(window, {
        socketIOConnect: connect,
        socketIODisconnect: disconnect,
        socketIOEmit: emitEvent,
        socketIOClear: clearLog,
    });

    log('ready', {
        message: 'UI initialised. Tap Connect to open the socket.',
        allowSelfSigned: shouldAllowSelfSigned,
    });
};

void init();
