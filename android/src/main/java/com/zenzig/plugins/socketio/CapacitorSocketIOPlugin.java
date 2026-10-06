package com.zenzig.plugins.socketio;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The Capacitor (WebView/UI) front-end of {@link SocketIOCore}. AF3c: the connection no longer belongs to this
 * plugin instance, so {@link #handleOnDestroy} only detaches this UI's event sink and leaves the socket (and the
 * foreground-service bridge) running for the Hermes runtime service; JS API and result shapes are unchanged.
 */
@CapacitorPlugin(name = "CapacitorSocketIO")
public class CapacitorSocketIOPlugin extends Plugin {

    private static final String LOG_TAG = "CapacitorSocketIOPlugin";

    private final SocketIOCore core = SocketIOCore.get();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final SocketIOCore.EventSink uiSink = (eventName, payload) -> notifyOnUiThread(eventName, payload);

    @Override
    public void load() {
        super.load();
        core.setContext(getContext());
        core.addSink(uiSink);
    }

    // Android replenishes the dataSync foreground-service budget once the app is back
    // in the foreground, so any quota-exhausted mark from a prior background session is
    // stale the moment the user reopens the app. ForegroundQuota.isExhausted also
    // self-expires after 24h as a backstop, but resume is the normal, fast path.
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        Context context = getContext();
        if (context != null) {
            ForegroundQuota.clear(context);
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        final String url = call.getString("url", CapacitorSocketIO.DEFAULT_URL);
        final JSObject options = call.getObject("options", new JSObject());
        core.setContext(getContext());
        core.connect(url, options, uiCallback(call));
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        core.disconnect(uiCallback(call));
    }

    @PluginMethod
    public void emit(PluginCall call) {
        final String event = call.getString("event");
        if (event == null || event.trim().isEmpty()) {
            call.reject("Event name is required");
            return;
        }
        core.emit(event, call.getObject("data"), call.getArray("args"), uiCallback(call));
    }

    @PluginMethod
    public void on(PluginCall call) {
        String event = call.getString("event");
        if (event == null || event.trim().isEmpty()) {
            call.reject("Event name is required");
            return;
        }
        try {
            call.resolve(toJSObject(core.on(event)));
        } catch (JSONException ex) {
            call.reject("Failed to listen: " + ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void drainBufferedEvents(PluginCall call) {
        try {
            call.resolve(toJSObject(core.drainBufferedEvents(call.getArray("events"))));
        } catch (JSONException ex) {
            call.reject("Failed to drain events: " + ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void isForegroundServiceRunning(PluginCall call) {
        try {
            call.resolve(toJSObject(core.isForegroundServiceRunning()));
        } catch (JSONException ex) {
            call.reject(ex.getMessage(), ex);
        }
    }

    /**
     * Starts (or re-starts) the Android foreground socket service independently of {@link #connect}; see
     * {@link SocketIOCore#startForegroundService}. {@code call}'s data is the foreground service config.
     */
    @PluginMethod
    public void startForegroundService(PluginCall call) {
        core.setContext(getContext());
        JSONObject config = call.getData();
        core.startForegroundService(config != null ? config : new JSONObject(), uiCallback(call));
    }

    /** Reports the foreground service's running state and whether the dataSync quota is currently exhausted. */
    @PluginMethod
    public void getForegroundServiceStatus(PluginCall call) {
        core.setContext(getContext());
        try {
            call.resolve(toJSObject(core.getForegroundServiceStatus()));
        } catch (JSONException ex) {
            call.reject(ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void stopForegroundService(PluginCall call) {
        core.setContext(getContext());
        core.stopForegroundService(uiCallback(call));
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        // AF3c: the socket belongs to the process (SocketIOCore), not to this Activity-bound plugin instance. Only the
        // UI's sink goes away; the connection keeps running for the runtime service and is reused by the next connect().
        core.removeSink(uiSink);
    }

    /** Kept for tests and diagnostics; the implementation lives in {@link SocketIOCore}. */
    static JSONObject throwableToJson(Throwable error) {
        return SocketIOCore.throwableToJson(error);
    }

    private SocketIOCore.Callback uiCallback(PluginCall call) {
        return new SocketIOCore.Callback() {
            @Override
            public void resolve(JSONObject result) {
                mainHandler.post(() -> call.resolve(toJSObject(result)));
            }

            @Override
            public void reject(String message, Exception error) {
                mainHandler.post(() -> {
                    Logger.error(LOG_TAG, message, error);
                    call.reject(message, null, error);
                });
            }
        };
    }

    private static JSObject toJSObject(JSONObject json) {
        if (json == null) return new JSObject();
        if (json instanceof JSObject) return (JSObject) json;
        try {
            return new JSObject(json.toString());
        } catch (JSONException error) {
            return new JSObject();
        }
    }

    private void notifyOnUiThread(String eventName, JSONObject payload) {
        JSObject data = toJSObject(payload);
        mainHandler.post(() -> notifyListeners(eventName, data));
    }
}
