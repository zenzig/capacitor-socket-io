package com.zenzig.plugins.socketio;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import com.getcapacitor.Logger;
import io.socket.client.IO;
import io.socket.client.Socket;
import java.lang.reflect.Field;
import java.net.URISyntaxException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * AF3c: the process-level owner of the Socket.IO connection. It used to live inside {@link CapacitorSocketIOPlugin}
 * (one {@link CapacitorSocketIO} per plugin instance, destroyed in handleOnDestroy), so the socket died with the
 * Activity. Now the plain-mode socket, the foreground-session bridge and the IO executor belong to this singleton:
 * the Capacitor plugin (UI) and the Hermes runtime's module host are both just front-ends that call it and receive
 * its events through {@link EventSink}s. Nothing here is tied to an Activity; the Activity going away only removes
 * the UI's sink.
 *
 * <p>Foreground-service behavior is unchanged: {@code connect} with {@code options.foregroundService} still routes
 * the connection through {@link SocketIOForegroundSession}'s socket and starts {@link SocketIOForegroundService}.
 */
public final class SocketIOCore {
    private static final String LOG_TAG = "SocketIOCore";
    private static volatile SocketIOCore instance;

    /** Completion of one core call. May be invoked on the core's IO thread. */
    public interface Callback {
        void resolve(JSONObject result);

        void reject(String message, Exception error);
    }

    /** Receives every socket event: {@code payload = {event, args[, id]}}; lifecycle events included. */
    public interface EventSink {
        void onSocketEvent(String eventName, JSONObject payload);
    }

    public static SocketIOCore get() {
        SocketIOCore local = instance;
        if (local == null) {
            synchronized (SocketIOCore.class) {
                local = instance;
                if (local == null) {
                    local = new SocketIOCore();
                    instance = local;
                }
            }
        }
        return local;
    }

    /** Test hook: a fresh core (the previous one is destroyed). */
    static synchronized SocketIOCore resetForTests() {
        SocketIOCore old = instance;
        if (old != null) old.destroy();
        instance = new SocketIOCore();
        return instance;
    }

    private final CapacitorSocketIO socketManager = new CapacitorSocketIO();
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread t = new Thread(runnable, "socketio-core");
        t.setDaemon(true);
        return t;
    });
    private final CopyOnWriteArraySet<EventSink> sinks = new CopyOnWriteArraySet<>();
    private volatile Context appContext;
    private volatile boolean usingForegroundSession;

    private SocketIOCore() {
        socketManager.setEventListener(this::handleSocketEvent);
        SocketIOForegroundSession.setPluginEventListener(this::handleSocketEvent);
    }

    public void setContext(Context context) {
        if (context != null) appContext = context.getApplicationContext() != null ? context.getApplicationContext() : context;
    }

    public void addSink(EventSink sink) {
        if (sink != null) sinks.add(sink);
    }

    public void removeSink(EventSink sink) {
        sinks.remove(sink);
    }

    public int sinkCount() {
        return sinks.size();
    }

    CapacitorSocketIO plainManager() {
        return socketManager;
    }

    /** Tears the plain socket down (process end / explicit reset). The Activity going away must NOT call this. */
    public void destroy() {
        socketManager.destroy();
        sinks.clear();
    }

    // ---------------------------------------------------------------- calls (same shapes the plugin always returned)

    public void connect(String url, JSONObject options, Callback callback) {
        final JSONObject opts = options == null ? new JSONObject() : options;
        final String target = url == null || url.isEmpty() ? CapacitorSocketIO.DEFAULT_URL : url;
        ioExecutor.execute(() -> {
            try {
                IO.Options ioOptions = buildIoOptions(target, opts);
                // Reuse a live/connecting socket for the same endpoint+options instead of tearing it down (a
                // redundant connect() used to close the websocket within a second).
                final String signature = target + "|" + opts.toString();
                CapacitorSocketIO current = activeSocketManager();
                if (current.canReuse(signature)) {
                    JSONObject reused = new JSONObject();
                    reused.put("status", current.isConnected() ? "connected" : "connecting");
                    reused.put("url", target);
                    reused.put("reused", true);
                    reused.put("foregroundService", usingForegroundSession);
                    callback.resolve(reused);
                    return;
                }
                boolean foregroundRequested = isForegroundServiceEnabled(opts);
                ForegroundServiceOutcome outcome = foregroundRequested
                    ? startSocketForegroundService(foregroundServiceConfig(opts))
                    : ForegroundServiceOutcome.notRequested();
                usingForegroundSession = outcome.started;
                if (current != activeSocketManager()) {
                    current.disconnect();
                }
                activeSocketManager().connect(target, ioOptions, signature);

                JSONObject result = new JSONObject();
                result.put("status", "connecting");
                result.put("url", target);
                result.put("reused", false);
                result.put("foregroundService", outcome.started);
                if (outcome.reason != null) {
                    result.put("reason", outcome.reason);
                }
                callback.resolve(result);
            } catch (URISyntaxException uriEx) {
                callback.reject("Invalid Socket.IO endpoint: " + uriEx.getMessage(), uriEx);
            } catch (Exception ex) {
                callback.reject("Failed to initiate connection: " + ex.getMessage(), ex);
            }
        });
    }

    public void disconnect(Callback callback) {
        ioExecutor.execute(() -> {
            activeSocketManager().disconnect();
            if (usingForegroundSession || SocketIOForegroundSession.isServiceRunning()) {
                stopSocketForegroundService();
            }
            usingForegroundSession = false;
            try {
                callback.resolve(new JSONObject().put("status", "disconnected"));
            } catch (JSONException impossible) {
                callback.resolve(new JSONObject());
            }
        });
    }

    public void emit(String event, JSONObject data, JSONArray argsArray, Callback callback) {
        if (event == null || event.trim().isEmpty()) {
            callback.reject("Event name is required", null);
            return;
        }
        ioExecutor.execute(() -> {
            try {
                Object[] payload = buildEmitPayload(data, argsArray);
                activeSocketManager().emit(event, payload);
                callback.resolve(new JSONObject().put("event", event).put("status", "emitted"));
            } catch (IllegalStateException stateEx) {
                callback.reject(stateEx.getMessage(), stateEx);
            } catch (JSONException jsonEx) {
                callback.reject("Unable to serialise emit payload: " + jsonEx.getMessage(), jsonEx);
            } catch (Exception ex) {
                callback.reject("Failed to emit event: " + ex.getMessage(), ex);
            }
        });
    }

    /** Registers native interest in {@code event} on both socket managers (plain and foreground session). */
    public JSONObject on(String event) throws JSONException {
        socketManager.listenTo(event);
        SocketIOForegroundSession.getSocketManager().listenTo(event);
        return new JSONObject().put("event", event).put("status", "listening");
    }

    public JSONObject drainBufferedEvents(JSONArray requestedEvents) throws JSONException {
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
        JSONArray events = new JSONArray();
        for (SocketIOForegroundSession.BufferedEvent event : drained) {
            JSONObject payload = new JSONObject();
            payload.put("event", event.eventName);
            payload.put("args", toJSArray(event.args));
            payload.put("receivedAt", event.receivedAt);
            events.put(payload);
        }
        return new JSONObject().put("events", events);
    }

    public JSONObject isForegroundServiceRunning() throws JSONException {
        return new JSONObject().put("running", SocketIOForegroundSession.isServiceRunning());
    }

    /** See the plugin's startForegroundService: keeps the process prioritized; does not migrate the live socket. */
    public void startForegroundService(JSONObject config, Callback callback) {
        ioExecutor.execute(() -> {
            try {
                ForegroundServiceOutcome outcome = startSocketForegroundService(config != null ? config : new JSONObject());
                JSONObject result = new JSONObject();
                result.put("running", SocketIOForegroundSession.isServiceRunning());
                result.put("started", outcome.started);
                if (outcome.reason != null) {
                    result.put("reason", outcome.reason);
                }
                callback.resolve(result);
            } catch (Exception ex) {
                callback.reject("Failed to start foreground service: " + ex.getMessage(), ex);
            }
        });
    }

    public JSONObject getForegroundServiceStatus() throws JSONException {
        Context context = appContext;
        boolean exhausted = context != null && ForegroundQuota.isExhausted(context);
        long exhaustedAt = context != null ? ForegroundQuota.exhaustedAt(context) : -1L;
        return new JSONObject()
            .put("running", SocketIOForegroundSession.isServiceRunning())
            .put("exhausted", exhausted)
            .put("exhaustedAt", exhaustedAt);
    }

    public void stopForegroundService(Callback callback) {
        ioExecutor.execute(() -> {
            // Only the session socket belongs to the foreground service. When the live socket is the plain one,
            // leave it connected (disconnecting here killed the live socket on every app-foreground, 2026-10-03).
            if (usingForegroundSession) {
                activeSocketManager().disconnect();
            }
            stopSocketForegroundService();
            usingForegroundSession = false;
            try {
                callback.resolve(new JSONObject().put("running", SocketIOForegroundSession.isServiceRunning()));
            } catch (JSONException impossible) {
                callback.resolve(new JSONObject());
            }
        });
    }

    public boolean isUsingForegroundSession() {
        return usingForegroundSession;
    }

    // ---------------------------------------------------------------- events

    private void handleSocketEvent(String eventName, Object[] args) {
        if (Socket.EVENT_CONNECT_ERROR.equals(eventName) && args != null && args.length > 0) {
            Logger.warn(LOG_TAG, "connect_error payload: " + args[0]);
        }
        JSONObject payload = new JSONObject();
        try {
            payload.put("event", eventName);
            payload.put("args", toJSArray(args));
            if (Socket.EVENT_CONNECT.equals(eventName)) {
                Socket activeSocket = activeSocketManager().getSocket();
                if (activeSocket != null) {
                    payload.put("id", activeSocket.id());
                }
            }
        } catch (JSONException ignored) {
            // keys are constants
        }
        dispatchToSinks(eventName, payload);
    }

    void dispatchToSinks(String eventName, JSONObject payload) {
        for (EventSink sink : sinks) {
            try {
                sink.onSocketEvent(eventName, payload);
            } catch (Throwable error) {
                warn("event sink failed: " + error.getMessage());
            }
        }
    }

    private static void warn(String message) {
        try {
            Logger.warn(LOG_TAG, message);
        } catch (RuntimeException ignore) {
            // android.util.Log is not available during plain JVM tests.
        }
    }

    // Routes strictly on this core's own usingForegroundSession flag - NOT on the static
    // SocketIOForegroundSession.isServiceRunning() - because the foreground Android service can be started/stopped
    // independently of connect() purely to keep the process prioritized while backgrounded.
    private CapacitorSocketIO activeSocketManager() {
        if (usingForegroundSession) {
            return SocketIOForegroundSession.getSocketManager();
        }
        return socketManager;
    }

    private boolean isForegroundServiceEnabled(JSONObject options) {
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
        Context context = appContext;
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
        Context context = appContext;
        if (context == null) {
            SocketIOForegroundSession.setServiceRunning(false);
            return;
        }
        SocketIOForegroundSession.clearEventNotifications();
        context.startService(SocketIOForegroundService.stopIntent(context));
    }

    private JSONObject foregroundServiceConfig(JSONObject options) {
        Object raw = options != null ? options.opt("foregroundService") : null;
        if (raw instanceof JSONObject) {
            return (JSONObject) raw;
        }
        return new JSONObject();
    }

    private IO.Options buildIoOptions(String url, JSONObject options) {
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

    private Object[] buildEmitPayload(JSONObject data, JSONArray args) throws JSONException {
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

    /** {message, cause ("a <- b" chain of cause messages), type} so JS can log why a connect failed. */
    public static JSONObject throwableToJson(Throwable error) {
        JSONObject json = new JSONObject();
        try {
            json.put("message", String.valueOf(error));
            StringBuilder chain = new StringBuilder();
            Throwable cause = error.getCause();
            int depth = 0;
            while (cause != null && cause != error && depth < 6) {
                if (chain.length() > 0) {
                    chain.append(" <- ");
                }
                chain.append(String.valueOf(cause));
                if (cause.getCause() == cause) {
                    break;
                }
                cause = cause.getCause();
                depth++;
            }
            json.put("cause", chain.toString());
            json.put("type", error.getClass().getSimpleName());
        } catch (org.json.JSONException ignore) {
            // keys are non-null constants; cannot happen
        }
        return json;
    }

    private JSONArray toJSArray(Object[] args) {
        JSONArray array = new JSONArray();
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
            } else if (arg instanceof Throwable) {
                array.put(throwableToJson((Throwable) arg));
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
        Context context = appContext;
        if (context == null) {
            return false;
        }

        ApplicationInfo appInfo = context.getApplicationInfo();
        return (appInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

}
