package com.zenzig.plugins.socketio;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import io.socket.client.IO;
import io.socket.client.Socket;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

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
        String proxyUrl = System.getenv("SOCKET_IO_PROXY_URL");
        Assume.assumeTrue(
            "Set SOCKET_IO_PROXY_URL to a reachable HTTPS Socket.IO proxy before running this test.",
            proxyUrl != null && !proxyUrl.trim().isEmpty()
        );

        CountDownLatch connectLatch = new CountDownLatch(1);
        CountDownLatch errorLatch = new CountDownLatch(1);
        CountDownLatch pongLatch = new CountDownLatch(1);
        AtomicReference<String> errorMessage = new AtomicReference<>("<no error>");
        AtomicReference<JSONObject> pongPayload = new AtomicReference<>();

        manager.setEventListener((eventName, args) -> {
            System.out.println("[SocketIOTest] Event: " + eventName + " -> " + Arrays.toString(args));
            if (Socket.EVENT_CONNECT.equals(eventName)) {
                connectLatch.countDown();
            }

            if ("pong".equals(eventName)) {
                if (args != null && args.length > 0) {
                    Object firstArg = args[0];
                    if (firstArg instanceof JSONObject) {
                        pongPayload.set((JSONObject) firstArg);
                    } else if (firstArg != null) {
                        try {
                            pongPayload.set(new JSONObject(firstArg.toString()));
                        } catch (Exception parseError) {
                            errorMessage.set("pong payload parse error -> " + parseError.getMessage());
                            errorLatch.countDown();
                        }
                    }
                }
                pongLatch.countDown();
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
        options.transports = new String[] { "websocket" };
        options.path = "/socket.io";
        OkHttpClient trustAllClient = buildTrustAllClient();
        options.callFactory = trustAllClient;
        options.webSocketFactory = trustAllClient;

        manager.connect(proxyUrl, options);

        boolean connected = connectLatch.await(25, TimeUnit.SECONDS);
        if (!connected) {
            if (errorLatch.await(1, TimeUnit.SECONDS)) {
                fail("Socket failed to connect: " + errorMessage.get());
            } else {
                fail("Socket failed to connect within timeout and no error was emitted");
            }
        }

        final String pingMessage = "Hello from Capacitor Android test";
        final int sequence = 1;

        JSONObject payload = new JSONObject();
        payload.put("deviceId", "android-unit-test");
        payload.put("alias", "Android JVM Test");
        payload.put("origin", "android-jvm");
        payload.put("message", pingMessage);
        payload.put("sequence", sequence);
        payload.put("sentAt", Instant.now().toString());

        manager.emit("ping", payload);

        boolean pongReceived = pongLatch.await(20, TimeUnit.SECONDS);
        if (!pongReceived) {
            if (errorLatch.getCount() == 0) {
                fail("Socket emitted error before pong: " + errorMessage.get());
            } else {
                fail("Timed out waiting for pong event");
            }
        }

        JSONObject pong = pongPayload.get();
        assertNotNull("Expected pong payload to be captured", pong);
        assertTrue("Pong payload should include original message", pingMessage.equals(pong.optString("message")));
        assertTrue("Pong payload should include matching sequence", pong.optInt("sequence", -1) == sequence);
        assertTrue(
            "Pong payload must include respondedAt timestamp",
            pong.has("respondedAt") && pong.optString("respondedAt").length() > 0
        );
        assertTrue("Pong payload must include non-negative latency", pong.has("latencyMs") && pong.optLong("latencyMs", -1) >= 0);
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
        sslContext.init(null, new TrustManager[] { trustManager }, new SecureRandom());

        return new OkHttpClient.Builder()
            .sslSocketFactory(sslContext.getSocketFactory(), trustManager)
            .hostnameVerifier((hostname, session) -> true)
            .build();
    }
}
