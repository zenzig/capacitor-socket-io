package com.zenzig.plugins.socketio;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Tracks whether the Android "dataSync" foreground-service quota has been exhausted.
 *
 * Android 15 (API 35) enforces a rolling budget of roughly 6 hours per 24 hours for
 * {@code dataSync} foreground services. Once the OS reports the budget is spent
 * (via {@link SocketIOForegroundService#onTimeout} or a
 * {@code ForegroundServiceStartNotAllowedException} thrown from
 * {@code Service#startForeground}), we record a mark here so the plugin stops trying
 * to start the foreground service again — Android replenishes the budget once the
 * app returns to the foreground, so {@code handleOnResume()} clears the mark
 * unconditionally at that point. {@link #isExhausted(Context)} additionally
 * self-expires the mark after 24 hours as a backstop for the case where the app
 * never comes back to the foreground (e.g. it stays backgrounded, or the process is
 * restarted by the OS without a resume ever firing).
 */
public final class ForegroundQuota {

    private static final String PREFS_NAME = "capacitor_socket_io_fgs";
    private static final String KEY_EXHAUSTED_AT = "exhausted_at";

    /** How long a mark stays "exhausted" before {@link #isExhausted} treats it as stale. */
    static final long MAX_AGE_MS = 24L * 60L * 60L * 1000L;

    private ForegroundQuota() {}

    /** Records that the dataSync quota was just exhausted at the given timestamp. */
    public static void markExhausted(Context context, long at) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return;
        }
        prefs.edit().putLong(KEY_EXHAUSTED_AT, at).apply();
    }

    /**
     * True when a quota-exhausted mark exists and is still within its 24h window.
     * Self-expires: once the mark is older than {@link #MAX_AGE_MS}, this returns
     * false even if {@link #clear} was never explicitly called.
     */
    public static boolean isExhausted(Context context) {
        return isExhausted(context, System.currentTimeMillis());
    }

    static boolean isExhausted(Context context, long now) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return false;
        }
        return isExhausted(prefs.getLong(KEY_EXHAUSTED_AT, -1L), now);
    }

    /**
     * Pure predicate extracted for unit testing without an Android {@link Context}:
     * a mark exists ({@code exhaustedAt >= 0}) and is within {@link #MAX_AGE_MS} of
     * {@code now}.
     */
    static boolean isExhausted(long exhaustedAt, long now) {
        if (exhaustedAt < 0) {
            return false;
        }
        return (now - exhaustedAt) < MAX_AGE_MS;
    }

    /** The timestamp of the current mark, or -1 when none is set. */
    public static long exhaustedAt(Context context) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return -1L;
        }
        return prefs.getLong(KEY_EXHAUSTED_AT, -1L);
    }

    /** Clears the mark unconditionally. Called from the plugin's handleOnResume(). */
    public static void clear(Context context) {
        SharedPreferences prefs = prefs(context);
        if (prefs == null) {
            return;
        }
        prefs.edit().remove(KEY_EXHAUSTED_AT).apply();
    }

    private static SharedPreferences prefs(Context context) {
        if (context == null) {
            return null;
        }
        return context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
}
