package com.zenzig.plugins.socketio;

import com.getcapacitor.Logger;
import io.socket.client.Ack;
import io.socket.client.IO;
import io.socket.client.Socket;
import io.socket.emitter.Emitter;
import java.net.URISyntaxException;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Thin wrapper around the Socket.IO Java client that keeps track of the active socket, the events
 * we've subscribed to, and forwards every event back to the provided listener. The Capacitor plugin
 * delegates all socket lifecycle management to this class so it can remain easily testable outside
 * of the Android runtime.
 */
public class CapacitorSocketIO {

    public static final String LOG_TAG = "CapacitorSocketIO";
    public static final String DEFAULT_URL = "https://socket-proxy.local/";

    /** Callback bridge that the Capacitor plugin implements so it can forward events to JS. */
    public interface SocketEventListener {
        void onEvent(String eventName, Object[] args);
    }

    private final Map<String, Emitter.Listener> coreListeners = new ConcurrentHashMap<>();
    private final Map<String, Emitter.Listener> managerListeners = new ConcurrentHashMap<>();
    /** Reconnect lifecycle lives on the Manager (socket.io()), never on the Socket itself. */
    static final String[] MANAGER_EVENTS = new String[] {
        "reconnect",
        "reconnect_attempt",
        "reconnect_error",
        "reconnect_failed"
    };
    private final Map<String, Emitter.Listener> dynamicListeners = new ConcurrentHashMap<>();
    private final Set<String> requestedEvents = ConcurrentHashMap.newKeySet();
    private static final String[] CORE_EVENTS = new String[] {
        "connect",
        "disconnect",
        "connect_error",
        "connect_timeout",
        "error",
        "message",
        "ping",
        "pong",
        "reconnect",
        "reconnect_attempt",
        "reconnect_error",
        "reconnect_failed",
        "reconnecting"
    };

    private volatile SocketEventListener eventListener;
    private Socket socket;
    private String activeSignature;
    /** Set once the socket cannot recover by itself; the next connect() must rebuild it. */
    private volatile boolean dead;

    public void setEventListener(SocketEventListener eventListener) {
        this.eventListener = eventListener;
    }

    /** Same as {@link #connect(String, IO.Options, String)} with the URL as the signature. */
    public synchronized boolean connect(String url, IO.Options options) throws URISyntaxException {
        String targetUrl = (url == null || url.trim().isEmpty()) ? DEFAULT_URL : url;
        return connect(targetUrl, options, targetUrl);
    }

    /**
     * Whether a connect() with this signature would reuse the live socket: a socket exists, was
     * created with the same signature, has not been torn down by disconnect(), and has not given
     * up reconnecting (reconnect_failed / server-initiated disconnect).
     */
    public synchronized boolean canReuse(String signature) {
        return socket != null && !dead && signature != null && signature.equals(activeSignature);
    }

    /**
     * Establishes a Socket.IO connection. If a socket for the same signature is already connected
     * or connecting (or auto-reconnecting) it is reused untouched, so a redundant connect() never
     * closes a live websocket. The socket is torn down and recreated only when the signature
     * differs, disconnect() was called, or the previous socket gave up.
     *
     * @return true when the existing socket was reused.
     */
    public synchronized boolean connect(String url, IO.Options options, String signature)
        throws URISyntaxException {
        String targetUrl = (url == null || url.trim().isEmpty()) ? DEFAULT_URL : url;
        if (canReuse(signature)) {
            logDebug("Reusing existing socket (url redacted)");
            return true;
        }
        logDebug("Connecting (url redacted)");

        disconnectInternal();

        IO.Options resolvedOptions = options != null ? options : new IO.Options();
        socket = IO.socket(targetUrl, resolvedOptions);
        activeSignature = signature;
        dead = false;

        attachCoreListeners();
        attachDynamicListeners();

        socket.connect();
        return false;
    }

    /** Disconnects the socket and clears any listeners that were attached. */
    public synchronized void disconnect() {
        logDebug("Disconnect requested");
        disconnectInternal();
    }

    /** Emits an event with optional payload arguments to the remote Socket.IO server. */
    public synchronized void emit(String event, Object... args) {
        if (socket == null) {
            throw new IllegalStateException("Socket is not connected. Call connect() first.");
        }

        if (args == null || args.length == 0) {
            socket.emit(event);
        } else {
            socket.emit(event, args);
        }
    }

    /** There is no live, connected socket to emit on. Still an IllegalStateException so existing catchers keep working. */
    public static final class NotConnectedException extends IllegalStateException {

        public NotConnectedException() {
            super("Socket is not connected. Call connect() first.");
        }
    }

    /**
     * Emits an event and hands the server's acknowledgement to {@code ack}. Unlike {@link #emit}, this refuses to
     * buffer: when the socket does not exist or is not connected right now it throws {@link NotConnectedException}
     * instead of queueing the packet for a later reconnect (the caller asked for an answer, not a delivery).
     * The caller owns the timeout; socket.io-client-java never calls {@code ack} if the server does not answer.
     */
    public synchronized void emitWithAck(String event, Object[] args, Ack ack) {
        if (socket == null || !socket.connected()) {
            throw new NotConnectedException();
        }
        socket.emit(event, args == null ? new Object[0] : args, ack);
    }

    /** Registers interest in the provided event name so it will be forwarded to the listener. */
    public synchronized void listenTo(String event) {
        if (event == null || event.trim().isEmpty()) {
            logWarn("Ignoring empty event subscription");
            return;
        }

        requestedEvents.add(event);
        attachDynamicListener(event);
    }

    /** Returns whether the underlying socket is both allocated and actively connected. */
    public synchronized boolean isConnected() {
        return socket != null && socket.connected();
    }

    /** Completely resets the wrapper, releasing any references to the Socket.IO client. */
    public synchronized void destroy() {
        requestedEvents.clear();
        disconnectInternal();
    }

    public synchronized Socket getSocket() {
        return socket;
    }

    private void disconnectInternal() {
        if (socket == null) {
            return;
        }

        coreListeners.forEach((event, listener) -> socket.off(event, listener));
        coreListeners.clear();

        io.socket.client.Manager manager = socket.io();
        if (manager != null) {
            managerListeners.forEach((event, listener) -> manager.off(event, listener));
        }
        managerListeners.clear();

        dynamicListeners.forEach((event, listener) -> socket.off(event, listener));
        dynamicListeners.clear();

        try {
            if (socket.connected()) {
                socket.disconnect();
            }
            socket.close();
        } catch (Exception ex) {
            logWarn("Error while disconnecting socket: " + ex.getMessage());
        } finally {
            socket = null;
            activeSignature = null;
        }
    }

    private void attachCoreListeners() {
        if (socket == null) {
            return;
        }

        for (String event : CORE_EVENTS) {
            attachCoreListener(event);
        }
        attachManagerListeners();
    }

    private void attachManagerListeners() {
        io.socket.client.Manager manager = socket.io();
        if (manager == null) {
            return;
        }
        for (String event : MANAGER_EVENTS) {
            Emitter.Listener listener = (args) -> {
                if ("reconnect_failed".equals(event)) {
                    dead = true;
                }
                dispatchEvent(event, args);
            };
            managerListeners.put(event, listener);
            manager.on(event, listener);
        }
    }

    private void attachCoreListener(String event) {
        Emitter.Listener listener = (args) -> {
            if ("reconnect_failed".equals(event)
                || ("disconnect".equals(event) && args != null && args.length > 0
                    && "io server disconnect".equals(String.valueOf(args[0])))) {
                dead = true;
            }
            dispatchEvent(event, args);
        };
        coreListeners.put(event, listener);
        socket.on(event, listener);
    }

    private void attachDynamicListeners() {
        requestedEvents.forEach(this::attachDynamicListener);
    }

    static boolean isCoreEvent(String event) {
        for (String core : CORE_EVENTS) {
            if (core.equals(event)) {
                return true;
            }
        }
        return false;
    }

    private void attachDynamicListener(String event) {
        // Core lifecycle events are always forwarded by attachCoreListeners(); a second native
        // listener would deliver every lifecycle event to JS twice.
        if (socket == null || isCoreEvent(event) || dynamicListeners.containsKey(event)) {
            return;
        }

        Emitter.Listener listener = (args) -> dispatchEvent(event, args);
        dynamicListeners.put(event, listener);
        socket.on(event, listener);
    }

    private void dispatchEvent(String event, Object[] args) {
        SocketEventListener listener = eventListener;
        if (listener != null) {
            listener.onEvent(event, args);
        }
    }

    private void logDebug(String message) {
        try {
            Logger.debug(LOG_TAG, message);
        } catch (RuntimeException ignore) {
            // android.util.Log is not available during plain JVM tests; swallow to keep tests green.
        }
    }

    private void logWarn(String message) {
        try {
            Logger.warn(LOG_TAG, message);
        } catch (RuntimeException ignore) {
            // android.util.Log is not available during plain JVM tests; swallow to keep tests green.
        }
    }
}
