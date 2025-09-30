import { CapacitorSocketIO } from '@zenzig/capacitor-socket-io';

const CORE_EVENTS = [
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
];

const serverUrlInput = document.getElementById('serverUrl');
const eventNameInput = document.getElementById('eventName');
const eventPayloadInput = document.getElementById('eventPayload');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const emitBtn = document.getElementById('emitBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const logElement = document.getElementById('eventLog');

const registeredEvents = new Set();

const formatTime = () => new Date().toLocaleTimeString();

const log = (message, data) => {
    const payload = data !== undefined ? ` ${JSON.stringify(data)}` : '';
    logElement.textContent = `[${formatTime()}] ${message}${payload}\n` + logElement.textContent;
};

const registerCoreListeners = async () => {
    await Promise.all(
        CORE_EVENTS.map(async (event) => {
            if (!registeredEvents.has(event)) {
                await CapacitorSocketIO.on({ event });
                registeredEvents.add(event);
            }

                    await CapacitorSocketIO.addListener(event, (payload) => {
                log(`event:${event}`, payload);
            });
        }),
    );
};

const ensureEventSubscribed = async (event) => {
    if (!event || registeredEvents.has(event)) {
        return;
    }

    await CapacitorSocketIO.on({ event });
    registeredEvents.add(event);
};

const connect = async () => {
    try {
        await ensureEventSubscribed('pong');
        await ensureEventSubscribed('message');
        const url = serverUrlInput.value.trim() || undefined;
        log('Connecting to', { url });
        await CapacitorSocketIO.connect({
            url,
            options: {
                allowSelfSigned: true,
                path: '/socket.io',
                transports: ['websocket'],
                reconnection: true,
                timeout: 10000,
            },
        });
    } catch (error) {
        log('connect:error', serialiseError(error));
    }
};

const disconnect = async () => {
    try {
        await CapacitorSocketIO.disconnect();
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

const init = async () => {
        registeredEvents.clear();
        await CapacitorSocketIO.removeAllListeners();
    await registerCoreListeners();
    connectBtn.addEventListener('click', connect);
    disconnectBtn.addEventListener('click', disconnect);
    emitBtn.addEventListener('click', emitEvent);
    clearLogBtn.addEventListener('click', () => {
        logElement.textContent = '';
    });

    // Expose helpers for quick debugging in DevTools.
    Object.assign(window, {
        socketIOConnect: connect,
        socketIODisconnect: disconnect,
        socketIOEmit: emitEvent,
    });

    log('ready', { message: 'UI initialised. Tap Connect to open the socket.' });
};

void init();
