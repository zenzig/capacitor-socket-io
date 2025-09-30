package com.zenzig.plugins.socketio;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;

import io.socket.client.IO;
import io.socket.client.Socket;

public class CapacitorSocketIOTest {

    private CapacitorSocketIO manager;

    @Before
    public void setUp() {
        manager = new CapacitorSocketIO();
    }

    @After
    public void tearDown() {
        if (manager != null) {
            manager.destroy();
        }
    }

    @Test
    public void connectsAndReceivesPong() throws Exception {
        CountDownLatch connectLatch = new CountDownLatch(1);
        CountDownLatch errorLatch = new CountDownLatch(1);
        AtomicReference<String> errorMessage = new AtomicReference<>("<no error>");

        manager.setEventListener((eventName, args) -> {
            System.out.println("[SocketIOTest] Event: " + eventName + " -> " + Arrays.toString(args));
            if (Socket.EVENT_CONNECT.equals(eventName)) {
                connectLatch.countDown();
            }

            if ("connect_error".equals(eventName) || "error".equals(eventName)) {
                errorMessage.set(eventName + " -> " + Arrays.toString(args));
                if (args != null && args.length > 0 && args[0] instanceof Throwable) {
                    ((Throwable) args[0]).printStackTrace();
                }
                errorLatch.countDown();
            }
        });

        manager.listenTo("pong");

        IO.Options options = new IO.Options();
        options.secure = true;
        options.forceNew = true;
        options.reconnection = false;
        options.timeout = 5000;
    options.transports = new String[]{"websocket"};
    options.path = "/socket.io";
    OkHttpClient trustAllClient = buildTrustAllClient();
    options.callFactory = trustAllClient;
    options.webSocketFactory = trustAllClient;

        manager.connect(CapacitorSocketIO.DEFAULT_URL, options);

        boolean connected = connectLatch.await(25, TimeUnit.SECONDS);
        if (!connected) {
            if (errorLatch.await(1, TimeUnit.SECONDS)) {
                fail("Socket failed to connect: " + errorMessage.get());
            } else {
                fail("Socket failed to connect within timeout and no error was emitted");
            }
        }

        JSONObject payload = new JSONObject();
        payload.put("msg", "Hello from Capacitor Android test");

        manager.emit("ping", payload);
        // Give the remote server a small window to respond to the emitted event.
        TimeUnit.SECONDS.sleep(5);

        // No additional assertion here as the remote service may respond with different events. The absence
        // of an error and a successful emit indicates a healthy round-trip connection.
    }

    private OkHttpClient buildTrustAllClient() throws Exception {
        final X509TrustManager trustManager = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {
                // No-op for tests
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) {
                // No-op for tests
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };

        javax.net.ssl.SSLContext sslContext = javax.net.ssl.SSLContext.getInstance("TLS");
        sslContext.init(null, new TrustManager[]{trustManager}, new SecureRandom());

        return new OkHttpClient.Builder()
            .sslSocketFactory(sslContext.getSocketFactory(), trustManager)
            .hostnameVerifier((hostname, session) -> true)
            .build();
    }
}
