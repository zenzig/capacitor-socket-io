package com.zenzig.plugins.socketio;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Process-local foreground socket state shared by the Capacitor plugin and the
 * Android foreground service. The service keeps the process prioritized; this
 * session owns the socket and buffers events that may arrive while WebView JS is
 * suspended.
 */
public final class SocketIOForegroundSession {

    public static final int DEFAULT_NOTIFICATION_ID = 4107;

    public static final class BufferedEvent {
        public final String eventName;
        public final Object[] args;
        public final long receivedAt;

        BufferedEvent(String eventName, Object[] args, long receivedAt) {
            this.eventName = eventName;
            this.args = args != null ? args.clone() : new Object[0];
            this.receivedAt = receivedAt;
        }
    }

    private static final int MAX_BUFFERED_EVENTS = 200;
    private static final CapacitorSocketIO socketManager = new CapacitorSocketIO();
    private static final ArrayDeque<BufferedEvent> bufferedEvents = new ArrayDeque<>();
    private static CapacitorSocketIO.SocketEventListener pluginEventListener;
    private static boolean serviceRunning;

    static {
        socketManager.setEventListener(SocketIOForegroundSession::handleSocketEvent);
    }

    private SocketIOForegroundSession() {}

    public static synchronized CapacitorSocketIO getSocketManager() {
        return socketManager;
    }

    public static synchronized void setPluginEventListener(CapacitorSocketIO.SocketEventListener listener) {
        pluginEventListener = listener;
    }

    public static synchronized void setServiceRunning(boolean running) {
        serviceRunning = running;
    }

    public static synchronized boolean isServiceRunning() {
        return serviceRunning;
    }

    public static synchronized List<BufferedEvent> drainBufferedEvents(Set<String> events) {
        Set<String> filter = events != null ? new HashSet<>(events) : null;
        List<BufferedEvent> drained = new ArrayList<>();
        ArrayDeque<BufferedEvent> retained = new ArrayDeque<>();

        while (!bufferedEvents.isEmpty()) {
            BufferedEvent event = bufferedEvents.removeFirst();
            if (filter == null || filter.isEmpty() || filter.contains(event.eventName)) {
                drained.add(event);
            } else {
                retained.addLast(event);
            }
        }

        bufferedEvents.addAll(retained);
        return drained;
    }

    public static synchronized void clearBufferedEvents() {
        bufferedEvents.clear();
    }

    private static void handleSocketEvent(String eventName, Object[] args) {
        CapacitorSocketIO.SocketEventListener listener;
        synchronized (SocketIOForegroundSession.class) {
            bufferedEvents.addLast(new BufferedEvent(eventName, args, System.currentTimeMillis()));
            while (bufferedEvents.size() > MAX_BUFFERED_EVENTS) {
                bufferedEvents.removeFirst();
            }
            listener = pluginEventListener;
        }

        if (listener != null) {
            listener.onEvent(eventName, args);
        }
    }
}
