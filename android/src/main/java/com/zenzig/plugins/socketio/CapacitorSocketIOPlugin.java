package com.zenzig.plugins.socketio;

import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URISyntaxException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import io.socket.client.IO;
import io.socket.client.Socket;
import okhttp3.OkHttpClient;

@CapacitorPlugin(name = "CapacitorSocketIO")
public class CapacitorSocketIOPlugin extends Plugin {

    private static final String LOG_TAG = "CapacitorSocketIOPlugin";

    private final CapacitorSocketIO socketManager = new CapacitorSocketIO();
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        super.load();
        socketManager.setEventListener(this::handleSocketEvent);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        final String url = call.getString("url", CapacitorSocketIO.DEFAULT_URL);
        final JSObject options = call.getObject("options", new JSObject());

        // Shift all socket IO work off the main thread so we don't block the UI.
        ioExecutor.execute(() -> {
            try {
                IO.Options ioOptions = buildIoOptions(url, options);
                socketManager.connect(url, ioOptions);

                JSObject result = new JSObject();
                result.put("status", "connecting");
                result.put("url", url);
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
            socketManager.disconnect();
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
                socketManager.emit(event, payload);

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

        JSObject result = new JSObject();
        result.put("event", event);
        result.put("status", "listening");
        call.resolve(result);
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
    }

    private void handleSocketEvent(String eventName, Object[] args) {
        JSObject payload = new JSObject();
        payload.put("event", eventName);
        payload.put("args", toJSArray(args));

        if (Socket.EVENT_CONNECT.equals(eventName)) {
            Socket activeSocket = socketManager.getSocket();
            if (activeSocket != null) {
                payload.put("id", activeSocket.id());
            }
        }

        notifyOnUiThread(eventName, payload);
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
        opts.reconnectionAttempts = options.has("reconnectionAttempts") ? options.optInt("reconnectionAttempts", opts.reconnectionAttempts) : opts.reconnectionAttempts;
        opts.timeout = options.has("timeout") ? options.optLong("timeout", opts.timeout) : opts.timeout;
        opts.reconnectionDelay = options.has("reconnectionDelay") ? options.optLong("reconnectionDelay", opts.reconnectionDelay) : opts.reconnectionDelay;
        opts.reconnectionDelayMax = options.has("reconnectionDelayMax") ? options.optLong("reconnectionDelayMax", opts.reconnectionDelayMax) : opts.reconnectionDelayMax;

        if (options.has("path")) {
            opts.path = options.optString("path", opts.path);
        }

        Object queryObject = options.opt("query");
        if (queryObject instanceof String) {
            opts.query = (String) queryObject;
        } else if (queryObject instanceof JSONObject) {
            opts.query = toQueryString((JSONObject) queryObject);
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
            } else if (arg instanceof JSONObject || arg instanceof JSONArray || arg instanceof Number || arg instanceof Boolean || arg instanceof String) {
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
            sslContext.init(null, new TrustManager[]{trustManager}, new SecureRandom());

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
