package com.zenzig.plugins.socketio;

import com.getcapacitor.Logger;
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

    public void setEventListener(SocketEventListener eventListener) {
        this.eventListener = eventListener;
    }

    /**
     * Establishes a new Socket.IO connection. Any previous connection is torn down to guarantee a
     * clean session.
     */
    public synchronized void connect(String url, IO.Options options) throws URISyntaxException {
        String targetUrl = (url == null || url.trim().isEmpty()) ? DEFAULT_URL : url;
        logDebug("Connecting to " + targetUrl);

        disconnectInternal();

        IO.Options resolvedOptions = options != null ? options : new IO.Options();
        socket = IO.socket(targetUrl, resolvedOptions);

        attachCoreListeners();
        attachDynamicListeners();

        socket.connect();
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
        }
    }

    private void attachCoreListeners() {
        if (socket == null) {
            return;
        }

        for (String event : CORE_EVENTS) {
            attachCoreListener(event);
        }
    }

    private void attachCoreListener(String event) {
        Emitter.Listener listener = (args) -> dispatchEvent(event, args);
        coreListeners.put(event, listener);
        socket.on(event, listener);
    }

    private void attachDynamicListeners() {
        requestedEvents.forEach(this::attachDynamicListener);
    }

    private void attachDynamicListener(String event) {
        if (socket == null || dynamicListeners.containsKey(event)) {
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
