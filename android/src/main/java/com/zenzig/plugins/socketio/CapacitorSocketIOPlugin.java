package com.zenzig.plugins.socketio;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import io.socket.client.IO;
import io.socket.client.Socket;
import java.lang.reflect.Field;
import java.net.URISyntaxException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "CapacitorSocketIO")
public class CapacitorSocketIOPlugin extends Plugin {

    private static final String LOG_TAG = "CapacitorSocketIOPlugin";

    private final CapacitorSocketIO socketManager = new CapacitorSocketIO();
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean usingForegroundSession;

    @Override
    public void load() {
        super.load();
        socketManager.setEventListener(this::handleSocketEvent);
        SocketIOForegroundSession.setPluginEventListener(this::handleSocketEvent);
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

        // Shift all socket IO work off the main thread so we don't block the UI.
        ioExecutor.execute(() -> {
            try {
                IO.Options ioOptions = buildIoOptions(url, options);
                // Reuse a live/connecting socket for the same endpoint+options instead of tearing
                // it down (a redundant connect() used to close the websocket within a second).
                final String signature = url + "|" + options.toString();
                CapacitorSocketIO current = activeSocketManager();
                if (current.canReuse(signature)) {
                    JSObject reused = new JSObject();
                    reused.put("status", current.isConnected() ? "connected" : "connecting");
                    reused.put("url", url);
                    reused.put("reused", true);
                    reused.put("foregroundService", usingForegroundSession);
                    resolveOnUiThread(call, reused);
                    return;
                }
                boolean foregroundRequested = isForegroundServiceEnabled(options);
                ForegroundServiceOutcome outcome = foregroundRequested
                    ? startSocketForegroundService(foregroundServiceConfig(options))
                    : ForegroundServiceOutcome.notRequested();
                usingForegroundSession = outcome.started;
                if (current != activeSocketManager()) {
                    current.disconnect();
                }
                activeSocketManager().connect(url, ioOptions, signature);

                JSObject result = new JSObject();
                result.put("status", "connecting");
                result.put("url", url);
                result.put("reused", false);
                result.put("foregroundService", outcome.started);
                if (outcome.reason != null) {
                    result.put("reason", outcome.reason);
                }
                resolveOnUiThread(call, result);
            } catch (URISyntaxException uriEx) {
                rejectOnUiThread(call, "Invalid Socket.IO endpoint: " + uriEx.getMessage(), uriEx);
            } catch (Exception ex) {
                rejectOnUiThread(call, "Failed to initiate connection: " + ex.getMessage(), ex);
            }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        ioExecutor.execute(() -> {
            activeSocketManager().disconnect();
            if (usingForegroundSession || SocketIOForegroundSession.isServiceRunning()) {
                stopSocketForegroundService();
            }
            usingForegroundSession = false;
            JSObject result = new JSObject();
            result.put("status", "disconnected");
            resolveOnUiThread(call, result);
        });
    }

    @PluginMethod
    public void emit(PluginCall call) {
        final String event = call.getString("event");
        if (event == null || event.trim().isEmpty()) {
            call.reject("Event name is required");
            return;
        }

        final JSObject data = call.getObject("data");
        final JSArray argsArray = call.getArray("args");

        ioExecutor.execute(() -> {
            try {
                Object[] payload = buildEmitPayload(data, argsArray);
                activeSocketManager().emit(event, payload);

                JSObject result = new JSObject();
                result.put("event", event);
                result.put("status", "emitted");
                resolveOnUiThread(call, result);
            } catch (IllegalStateException stateEx) {
                rejectOnUiThread(call, stateEx.getMessage(), stateEx);
            } catch (JSONException jsonEx) {
                rejectOnUiThread(call, "Unable to serialise emit payload: " + jsonEx.getMessage(), jsonEx);
            } catch (Exception ex) {
                rejectOnUiThread(call, "Failed to emit event: " + ex.getMessage(), ex);
            }
        });
    }

    @PluginMethod
    public void on(PluginCall call) {
        String event = call.getString("event");
        if (event == null || event.trim().isEmpty()) {
            call.reject("Event name is required");
            return;
        }

        socketManager.listenTo(event);
        SocketIOForegroundSession.getSocketManager().listenTo(event);

        JSObject result = new JSObject();
        result.put("event", event);
        result.put("status", "listening");
        call.resolve(result);
    }

    @PluginMethod
    public void drainBufferedEvents(PluginCall call) {
        JSArray requestedEvents = call.getArray("events");
        Set<String> filter = new HashSet<>();
        if (requestedEvents != null) {
            for (int i = 0; i < requestedEvents.length(); i++) {
                String event = requestedEvents.optString(i, "");
                if (event != null && !event.trim().isEmpty()) {
                    filter.add(event.trim());
                }
            }
        }

        List<SocketIOForegroundSession.BufferedEvent> drained = SocketIOForegroundSession.drainBufferedEvents(filter);
        JSArray events = new JSArray();
        for (SocketIOForegroundSession.BufferedEvent event : drained) {
            JSObject payload = new JSObject();
            payload.put("event", event.eventName);
            payload.put("args", toJSArray(event.args));
            payload.put("receivedAt", event.receivedAt);
            events.put(payload);
        }

        JSObject result = new JSObject();
        result.put("events", events);
        call.resolve(result);
    }

    @PluginMethod
    public void isForegroundServiceRunning(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", SocketIOForegroundSession.isServiceRunning());
        call.resolve(result);
    }

    /**
     * Starts (or re-starts) the Android foreground socket service independently of
     * {@link #connect}, so callers can defer requesting it until there is an actual
     * reason to keep the socket alive in the background (e.g. app backgrounding with
     * an active watch/job). {@code call}'s data is used directly as the foreground
     * service config (notificationTitle/notificationText/notificationId/eventNotifications
     * — the same shape as {@code options.foregroundService} passed to connect()).
     *
     * Deliberately does NOT touch usingForegroundSession / route future emit()/on()/
     * disconnect() calls onto the session socket manager: when connect() did not itself
     * request the foreground session, the live socket lives on this instance's plain
     * socketManager, and this method's only job is to keep the *process* alive/
     * prioritized (any started foreground service does that for every component in the
     * process) — not to migrate an already-connected socket to a different, unconnected
     * manager instance.
     */
    @PluginMethod
    public void startForegroundService(PluginCall call) {
        ioExecutor.execute(() -> {
            JSONObject config = call.getData();
            ForegroundServiceOutcome outcome = startSocketForegroundService(config != null ? config : new JSONObject());

            JSObject result = new JSObject();
            result.put("running", SocketIOForegroundSession.isServiceRunning());
            result.put("started", outcome.started);
            if (outcome.reason != null) {
                result.put("reason", outcome.reason);
            }
            resolveOnUiThread(call, result);
        });
    }

    /**
     * Reports the foreground service's running state and whether the dataSync
     * time-limit quota is currently exhausted (and since when), so JS can decide
     * whether it is worth attempting {@link #startForegroundService}.
     */
    @PluginMethod
    public void getForegroundServiceStatus(PluginCall call) {
        Context context = getContext();
        boolean exhausted = context != null && ForegroundQuota.isExhausted(context);
        long exhaustedAt = context != null ? ForegroundQuota.exhaustedAt(context) : -1L;

        JSObject result = new JSObject();
        result.put("running", SocketIOForegroundSession.isServiceRunning());
        result.put("exhausted", exhausted);
        result.put("exhaustedAt", exhaustedAt);
        call.resolve(result);
    }

    @PluginMethod
    public void stopForegroundService(PluginCall call) {
        ioExecutor.execute(() -> {
            activeSocketManager().disconnect();
            stopSocketForegroundService();
            usingForegroundSession = false;

            JSObject result = new JSObject();
            result.put("running", SocketIOForegroundSession.isServiceRunning());
            resolveOnUiThread(call, result);
        });
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();

        ioExecutor.execute(socketManager::destroy);

        ioExecutor.shutdown();
        try {
            if (!ioExecutor.awaitTermination(2, TimeUnit.SECONDS)) {
                ioExecutor.shutdownNow();
            }
        } catch (InterruptedException interruptedException) {
            Logger.warn(LOG_TAG, "Executor termination interrupted");
            ioExecutor.shutdownNow();
            Thread.currentThread().interrupt();
        }

        socketManager.setEventListener(null);
        SocketIOForegroundSession.setPluginEventListener(null);
    }

    private void handleSocketEvent(String eventName, Object[] args) {
        if (Socket.EVENT_CONNECT_ERROR.equals(eventName) && args != null && args.length > 0) {
            Logger.warn(LOG_TAG, "connect_error payload: " + args[0]);
        }

        JSObject payload = new JSObject();
        payload.put("event", eventName);
        payload.put("args", toJSArray(args));

        if (Socket.EVENT_CONNECT.equals(eventName)) {
            Socket activeSocket = activeSocketManager().getSocket();
            if (activeSocket != null) {
                payload.put("id", activeSocket.id());
            }
        }

        notifyOnUiThread(eventName, payload);
    }

    // Routes strictly on this instance's own usingForegroundSession flag — NOT on the
    // static SocketIOForegroundSession.isServiceRunning() — because the foreground
    // Android service can now be started/stopped independently of connect() (see
    // startForegroundService()/stopForegroundService()) purely to keep the process
    // prioritized while backgrounded. Falling back to the static "is any foreground
    // service running anywhere" flag would silently reroute an already-connected plain
    // socket onto the (unconnected) session socket manager the moment some unrelated
    // caller starts the foreground service, breaking emit()/on()/disconnect() for the
    // live connection.
    private CapacitorSocketIO activeSocketManager() {
        if (usingForegroundSession) {
            return SocketIOForegroundSession.getSocketManager();
        }
        return socketManager;
    }

    private boolean isForegroundServiceEnabled(JSObject options) {
        if (options == null || !options.has("foregroundService")) {
            return false;
        }

        Object raw = options.opt("foregroundService");
        if (raw instanceof Boolean) {
            return (Boolean) raw;
        }
        if (raw instanceof JSONObject) {
            return ((JSONObject) raw).optBoolean("enabled", true);
        }

        return false;
    }

    /** Result of attempting to start the Android foreground socket service. */
    private static final class ForegroundServiceOutcome {
        final boolean started;
        final String reason;

        private ForegroundServiceOutcome(boolean started, String reason) {
            this.started = started;
            this.reason = reason;
        }

        static ForegroundServiceOutcome notRequested() {
            return new ForegroundServiceOutcome(false, null);
        }

        static ForegroundServiceOutcome started() {
            return new ForegroundServiceOutcome(true, null);
        }

        static ForegroundServiceOutcome failed(String reason) {
            return new ForegroundServiceOutcome(false, reason);
        }
    }

    private ForegroundServiceOutcome startSocketForegroundService(JSONObject config) {
        Context context = getContext();
        if (context == null) {
            return ForegroundServiceOutcome.failed("no-context");
        }
        if (ForegroundQuota.isExhausted(context)) {
            return ForegroundServiceOutcome.failed("quota-exhausted");
        }

        String title = config.optString("notificationTitle", "Socket.IO connection active");
        String text = config.optString("notificationText", "Keeping a real-time connection available.");
        int notificationId = config.optInt("notificationId", SocketIOForegroundSession.DEFAULT_NOTIFICATION_ID);

        SocketIOForegroundSession.configureEventNotifications(context, config);
        Intent intent = SocketIOForegroundService.startIntent(context, title, text, notificationId);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception ex) {
            Logger.warn(LOG_TAG, "Failed to start foreground socket service: " + ex.getMessage());
            return ForegroundServiceOutcome.failed("start-failed");
        }
        return ForegroundServiceOutcome.started();
    }

    private void stopSocketForegroundService() {
        Context context = getContext();
        if (context == null) {
            SocketIOForegroundSession.setServiceRunning(false);
            return;
        }
        SocketIOForegroundSession.clearEventNotifications();
        context.startService(SocketIOForegroundService.stopIntent(context));
    }

    private JSONObject foregroundServiceConfig(JSObject options) {
        Object raw = options != null ? options.opt("foregroundService") : null;
        if (raw instanceof JSONObject) {
            return (JSONObject) raw;
        }
        return new JSONObject();
    }

    private IO.Options buildIoOptions(String url, JSObject options) {
        IO.Options opts = new IO.Options();
        opts.forceNew = true;

        if (options == null) {
            opts.secure = url != null && url.startsWith("https");
            return opts;
        }

        // Mirror the most common Socket.IO options so the JS layer can configure behaviour.
        opts.secure = options.has("secure") ? options.optBoolean("secure", false) : url != null && url.startsWith("https");
        opts.reconnection = options.optBoolean("reconnection", opts.reconnection);
        opts.reconnectionAttempts = options.has("reconnectionAttempts")
            ? options.optInt("reconnectionAttempts", opts.reconnectionAttempts)
            : opts.reconnectionAttempts;
        opts.timeout = options.has("timeout") ? options.optLong("timeout", opts.timeout) : opts.timeout;
        opts.reconnectionDelay = options.has("reconnectionDelay")
            ? options.optLong("reconnectionDelay", opts.reconnectionDelay)
            : opts.reconnectionDelay;
        opts.reconnectionDelayMax = options.has("reconnectionDelayMax")
            ? options.optLong("reconnectionDelayMax", opts.reconnectionDelayMax)
            : opts.reconnectionDelayMax;

        if (options.has("path")) {
            opts.path = options.optString("path", opts.path);
        }

        String queryString = null;
        Object queryObject = options.opt("query");
        if (queryObject instanceof String) {
            queryString = (String) queryObject;
        } else if (queryObject instanceof JSONObject) {
            queryString = toQueryString((JSONObject) queryObject);
        }

        JSONObject authObject = normaliseAuthPayload(options.opt("auth"));
        if (authObject != null && authObject.length() > 0) {
            tryInjectAuth(opts, authObject);
            queryString = mergeQueryStrings(queryString, toQueryString(authObject));
        }

        if (queryString != null && !queryString.trim().isEmpty()) {
            opts.query = queryString;
        }

        JSONArray transportsArray = options.optJSONArray("transports");
        if (transportsArray != null && transportsArray.length() > 0) {
            String[] transports = new String[transportsArray.length()];
            for (int i = 0; i < transportsArray.length(); i++) {
                transports[i] = transportsArray.optString(i);
            }
            opts.transports = transports;
        }

        if (options.optBoolean("allowSelfSigned", false)) {
            ensureSelfSignedAllowed();
            configureTrustAllSsl(opts);
        }

        return opts;
    }

    private Object[] buildEmitPayload(JSObject data, JSArray args) throws JSONException {
        if (args != null && args.length() > 0) {
            Object[] payload = new Object[args.length()];
            for (int i = 0; i < args.length(); i++) {
                payload[i] = args.isNull(i) ? JSONObject.NULL : args.get(i);
            }
            return payload;
        }

        if (data != null) {
            return new Object[] { data };
        }

        return new Object[0];
    }

    private JSArray toJSArray(Object[] args) {
        JSArray array = new JSArray();
        if (args == null || args.length == 0) {
            return array;
        }

        for (Object arg : args) {
            if (arg == null) {
                array.put(JSONObject.NULL);
            } else if (
                arg instanceof JSONObject ||
                arg instanceof JSONArray ||
                arg instanceof Number ||
                arg instanceof Boolean ||
                arg instanceof String
            ) {
                array.put(arg);
            } else if (arg instanceof byte[]) {
                array.put(new String((byte[]) arg, StandardCharsets.UTF_8));
            } else {
                // Fallback to string representation for types we don't explicitly support.
                array.put(String.valueOf(arg));
            }
        }

        return array;
    }

    private String toQueryString(JSONObject json) {
        if (json == null || json.length() == 0) {
            return null;
        }

        StringBuilder builder = new StringBuilder();
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            String value = json.optString(key, "");
            if (builder.length() > 0) {
                builder.append('&');
            }
            builder.append(encode(key)).append('=').append(encode(value));
        }

        return builder.toString();
    }

    private String encode(String value) {
        try {
            return URLEncoder.encode(value, StandardCharsets.UTF_8.name());
        } catch (Exception ex) {
            Logger.warn(LOG_TAG, "Failed to url-encode value: " + value);
            return value;
        }
    }

    private JSONObject normaliseAuthPayload(Object raw) {
        if (raw == null || raw == JSONObject.NULL) {
            return null;
        }

        if (raw instanceof JSONObject) {
            return (JSONObject) raw;
        }

        if (raw instanceof String) {
            String token = ((String) raw).trim();
            if (token.isEmpty()) {
                return null;
            }

            JSONObject json = new JSONObject();
            try {
                json.put("token", token);
            } catch (JSONException ignore) {
                return null;
            }
            return json;
        }

        if (raw instanceof Number || raw instanceof Boolean) {
            JSONObject json = new JSONObject();
            try {
                json.put("token", raw);
            } catch (JSONException ignore) {
                return null;
            }
            return json;
        }

        return null;
    }

    private void tryInjectAuth(IO.Options opts, JSONObject authObject) {
        Map<String, Object> authMap = jsonToMap(authObject);
        if (authMap.isEmpty()) {
            return;
        }

        try {
            Field authField = IO.Options.class.getField("auth");
            Object existing = authField.get(opts);
            if (existing instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> existingMap = (Map<String, Object>) existing;
                existingMap.putAll(authMap);
            } else {
                authField.set(opts, authMap);
            }
        } catch (NoSuchFieldException | IllegalAccessException ignored) {
            // Older socket.io-client releases do not expose IO.Options.auth; fall back to query
            // parameters which the proxy also accepts.
        }
    }

    private Map<String, Object> jsonToMap(JSONObject json) {
        Map<String, Object> map = new HashMap<>();
        if (json == null) {
            return map;
        }

        Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (key == null || key.trim().isEmpty()) {
                continue;
            }

            Object value = json.opt(key);
            if (value == JSONObject.NULL || value == null) {
                continue;
            }

            map.put(key, value);
        }

        return map;
    }

    private String mergeQueryStrings(String base, String addition) {
        if (addition == null || addition.trim().isEmpty()) {
            return base;
        }

        if (base == null || base.trim().isEmpty()) {
            return addition;
        }

        return base + '&' + addition;
    }

    private void configureTrustAllSsl(IO.Options opts) {
        try {
            X509TrustManager trustManager = new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) {
                    // Intentionally left blank
                }

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) {
                    // Intentionally left blank
                }

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            };

            SSLContext sslContext = SSLContext.getInstance("TLS");
            sslContext.init(null, new TrustManager[] { trustManager }, new SecureRandom());

            OkHttpClient client = new OkHttpClient.Builder()
                .sslSocketFactory(sslContext.getSocketFactory(), trustManager)
                .hostnameVerifier((hostname, session) -> true)
                .build();

            opts.callFactory = client;
            opts.webSocketFactory = client;
            opts.secure = true;
        } catch (Exception ex) {
            Logger.warn(LOG_TAG, "Unable to configure trust-all SSL context: " + ex.getMessage());
        }
    }

    private void ensureSelfSignedAllowed() {
        if (isDebuggableBuild()) {
            return;
        }

        throw new SecurityException(
            "allowSelfSigned is only supported in debug builds. Configure certificate pinning or trusted CAs for release usage."
        );
    }

    private boolean isDebuggableBuild() {
        Context context = getContext();
        if (context == null) {
            return false;
        }

        ApplicationInfo appInfo = context.getApplicationInfo();
        return (appInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private void resolveOnUiThread(PluginCall call, JSObject data) {
        mainHandler.post(() -> call.resolve(data));
    }

    private void rejectOnUiThread(PluginCall call, String message, Exception error) {
        mainHandler.post(() -> {
            Logger.error(LOG_TAG, message, error);
            call.reject(message, null, error);
        });
    }

    private void notifyOnUiThread(String eventName, JSObject payload) {
        mainHandler.post(() -> notifyListeners(eventName, payload));
    }
}
