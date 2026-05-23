package com.zenzig.plugins.socketio;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

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
    private static final String EVENT_NOTIFICATION_CHANNEL_ID = "capacitor_socket_io_events";
    private static final String EVENT_NOTIFICATION_CHANNEL_NAME = "Socket.IO event updates";
    private static final CapacitorSocketIO socketManager = new CapacitorSocketIO();
    private static final ArrayDeque<BufferedEvent> bufferedEvents = new ArrayDeque<>();
    private static final Map<String, EventNotificationConfig> eventNotifications = new HashMap<>();
    private static CapacitorSocketIO.SocketEventListener pluginEventListener;
    private static Context applicationContext;
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

    public static synchronized void configureEventNotifications(Context context, JSONObject foregroundServiceConfig) {
        eventNotifications.clear();
        applicationContext = context != null ? context.getApplicationContext() : null;
        JSONArray notifications = foregroundServiceConfig != null
            ? foregroundServiceConfig.optJSONArray("eventNotifications")
            : null;
        if (notifications == null) {
            return;
        }

        for (int i = 0; i < notifications.length(); i++) {
            JSONObject json = notifications.optJSONObject(i);
            if (json == null) {
                continue;
            }
            EventNotificationConfig config = EventNotificationConfig.fromJson(json);
            if (config != null) {
                eventNotifications.put(config.event, config);
            }
        }
    }

    public static synchronized void clearEventNotifications() {
        eventNotifications.clear();
        applicationContext = null;
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
        EventNotificationConfig notificationConfig;
        Context context;
        synchronized (SocketIOForegroundSession.class) {
            bufferedEvents.addLast(new BufferedEvent(eventName, args, System.currentTimeMillis()));
            while (bufferedEvents.size() > MAX_BUFFERED_EVENTS) {
                bufferedEvents.removeFirst();
            }
            listener = pluginEventListener;
            notificationConfig = eventNotifications.get(eventName);
            context = applicationContext;
        }

        showEventNotification(context, notificationConfig, args);

        if (listener != null) {
            listener.onEvent(eventName, args);
        }
    }

    private static void showEventNotification(Context context, EventNotificationConfig config, Object[] args) {
        if (context == null || config == null || !canPostNotifications(context)) {
            return;
        }
        String eventId = extractEventId(args, config.idField);
        ensureEventNotificationChannel(context);
        int icon = context.getApplicationInfo().icon != 0
            ? context.getApplicationInfo().icon
            : android.R.drawable.stat_notify_sync;
        Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launchIntent == null) {
            launchIntent = new Intent();
        }
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (!eventId.isEmpty()) {
            launchIntent.putExtra("researchJobId", eventId);
            launchIntent.putExtra("backgroundResearchJobId", eventId);
            if (!config.deepLinkPrefix.isEmpty()) {
                launchIntent.setData(Uri.parse(config.deepLinkPrefix + Uri.encode(eventId)));
            }
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(
            context,
            config.notificationId + Math.abs(eventId.hashCode() % 1000),
            launchIntent,
            flags
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, EVENT_NOTIFICATION_CHANNEL_ID)
            : new Notification.Builder(context);
        Notification notification = builder
            .setSmallIcon(icon)
            .setContentTitle(config.notificationTitle)
            .setContentText(config.notificationText)
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .build();
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(config.notificationId + Math.abs(eventId.hashCode() % 1000), notification);
        }
    }

    private static boolean canPostNotifications(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private static void ensureEventNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(EVENT_NOTIFICATION_CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            EVENT_NOTIFICATION_CHANNEL_ID,
            EVENT_NOTIFICATION_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Socket.IO foreground event updates.");
        manager.createNotificationChannel(channel);
    }

    private static String extractEventId(Object[] args, String idField) {
        if (args == null || args.length == 0 || args[0] == null) {
            return "";
        }
        Object firstArg = args[0];
        if (firstArg instanceof JSONObject) {
            JSONObject json = (JSONObject) firstArg;
            String id = json.optString(idField, "");
            if (id.isEmpty()) {
                id = json.optString("jobId", json.optString("gatewayJobId", ""));
            }
            return id.trim();
        }
        return "";
    }

    private static String nonBlank(String value, String fallback) {
        return value != null && !value.trim().isEmpty() ? value.trim() : fallback;
    }

    private static final class EventNotificationConfig {
        final String event;
        final String notificationTitle;
        final String notificationText;
        final int notificationId;
        final String deepLinkPrefix;
        final String idField;

        private EventNotificationConfig(
            String event,
            String notificationTitle,
            String notificationText,
            int notificationId,
            String deepLinkPrefix,
            String idField
        ) {
            this.event = event;
            this.notificationTitle = notificationTitle;
            this.notificationText = notificationText;
            this.notificationId = notificationId;
            this.deepLinkPrefix = deepLinkPrefix;
            this.idField = idField;
        }

        static EventNotificationConfig fromJson(JSONObject json) {
            String event = json.optString("event", "").trim();
            if (event.isEmpty()) {
                return null;
            }
            return new EventNotificationConfig(
                event,
                nonBlank(json.optString("notificationTitle", ""), "Socket.IO event received"),
                nonBlank(json.optString("notificationText", ""), "Tap to open the app."),
                json.optInt("notificationId", DEFAULT_NOTIFICATION_ID + 1),
                json.optString("deepLinkPrefix", ""),
                nonBlank(json.optString("idField", ""), "id")
            );
        }
    }
}
