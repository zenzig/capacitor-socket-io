package com.zenzig.plugins.socketio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

public class SocketIOForegroundService extends Service {

    public static final String ACTION_START = "com.zenzig.plugins.socketio.START_FOREGROUND_SOCKET";
    public static final String ACTION_STOP = "com.zenzig.plugins.socketio.STOP_FOREGROUND_SOCKET";
    public static final String EXTRA_NOTIFICATION_TITLE = "notificationTitle";
    public static final String EXTRA_NOTIFICATION_TEXT = "notificationText";
    public static final String EXTRA_NOTIFICATION_ID = "notificationId";

    private static final String CHANNEL_ID = "capacitor_socket_io_foreground";
    private static final String CHANNEL_NAME = "Socket.IO connections";
    private static final String DEFAULT_TITLE = "Socket.IO connection active";
    private static final String DEFAULT_TEXT = "Keeping a real-time connection available.";

    public static Intent startIntent(Context context, String title, String text, int notificationId) {
        Intent intent = new Intent(context, SocketIOForegroundService.class);
        intent.setAction(ACTION_START);
        intent.putExtra(EXTRA_NOTIFICATION_TITLE, title);
        intent.putExtra(EXTRA_NOTIFICATION_TEXT, text);
        intent.putExtra(EXTRA_NOTIFICATION_ID, notificationId);
        return intent;
    }

    public static Intent stopIntent(Context context) {
        Intent intent = new Intent(context, SocketIOForegroundService.class);
        intent.setAction(ACTION_STOP);
        return intent;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            SocketIOForegroundSession.setServiceRunning(false);
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        ensureNotificationChannel();
        int notificationId = intent != null
            ? intent.getIntExtra(EXTRA_NOTIFICATION_ID, SocketIOForegroundSession.DEFAULT_NOTIFICATION_ID)
            : SocketIOForegroundSession.DEFAULT_NOTIFICATION_ID;
        String title = intent != null ? intent.getStringExtra(EXTRA_NOTIFICATION_TITLE) : null;
        String text = intent != null ? intent.getStringExtra(EXTRA_NOTIFICATION_TEXT) : null;

        // A null intent means the system restarted us on its own (we used to return
        // START_STICKY, which is exactly how the crash loop happened: Android 15 kills
        // the service once the dataSync foreground-service time limit is hit, then
        // redelivers a null intent because of START_STICKY, and startForeground() below
        // throws immediately because the quota is still exhausted — an infinite crash
        // loop). Always return START_NOT_STICKY so the system never retries us on its
        // own; the plugin decides when to start the service again (next connect/background).
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(notificationId, buildNotification(title, text), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(notificationId, buildNotification(title, text));
            }
        } catch (Exception startError) {
            // Includes ForegroundServiceStartNotAllowedException (API 31+): the dataSync
            // time budget is already spent for this 24h window. Give up cleanly instead
            // of leaving the service half-started.
            SocketIOForegroundSession.setServiceRunning(false);
            ForegroundQuota.markExhausted(getApplicationContext(), System.currentTimeMillis());
            stopSelf();
            SocketIOForegroundSession.notifyServiceUnavailable(describeStartFailure(startError));
            return START_NOT_STICKY;
        }

        SocketIOForegroundSession.setServiceRunning(true);
        return START_NOT_STICKY;
    }

    /**
     * API 34 (Android 14): called when this service type's time limit is reached.
     * We must stop the service ourselves — the base Service implementation does not.
     */
    @Override
    public void onTimeout(int startId) {
        handleTimeout();
    }

    /**
     * API 35 (Android 15): the two-arg overload used when a service declares multiple
     * foreground service types. We only ever declare dataSync, but implement it too so
     * devices on API 35+ never fall back to the (unimplemented-by-default) base Service
     * behaviour for this signature.
     */
    @Override
    public void onTimeout(int startId, int fgsType) {
        handleTimeout();
    }

    private void handleTimeout() {
        long now = System.currentTimeMillis();
        SocketIOForegroundSession.setServiceRunning(false);
        ForegroundQuota.markExhausted(getApplicationContext(), now);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        SocketIOForegroundSession.notifyServiceTimeout(now);
    }

    private String describeStartFailure(Exception startError) {
        String className = startError.getClass().getSimpleName();
        if ("ForegroundServiceStartNotAllowedException".equals(className)) {
            return "quota-exhausted";
        }
        return "start-failed:" + className;
    }

    @Override
    public void onDestroy() {
        SocketIOForegroundSession.setServiceRunning(false);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification(String title, String text) {
        int icon = getApplicationInfo().icon != 0
            ? getApplicationInfo().icon
            : android.R.drawable.stat_notify_sync;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        return builder
            .setContentTitle(nonBlank(title, DEFAULT_TITLE))
            .setContentText(nonBlank(text, DEFAULT_TEXT))
            .setSmallIcon(icon)
            .setOngoing(true)
            .build();
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps native Socket.IO sessions alive while work is in progress.");
        manager.createNotificationChannel(channel);
    }

    private String nonBlank(String value, String fallback) {
        return value != null && !value.trim().isEmpty() ? value.trim() : fallback;
    }
}
