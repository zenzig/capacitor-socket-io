package com.zenzig.plugins.socketio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
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

        startForeground(notificationId, buildNotification(title, text));
        SocketIOForegroundSession.setServiceRunning(true);
        return START_STICKY;
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
