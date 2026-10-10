package com.zenzig.plugins.socketio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import io.socket.client.IO;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** AF3c: the socket is process-level; the Activity (UI sink) coming and going must not touch it. */
public class SocketIOCoreTest {
    private SocketIOCore core;

    @Before
    public void setUp() {
        core = SocketIOCore.resetForTests();
    }

    @After
    public void tearDown() {
        core.destroy();
    }

    @Test
    public void getReturnsOneProcessLevelInstance() {
        assertSame(SocketIOCore.get(), SocketIOCore.get());
        assertSame(core, SocketIOCore.get());
    }

    @Test
    public void everySinkReceivesEveryEvent() throws Exception {
        List<String> ui = new ArrayList<>();
        List<String> engine = new ArrayList<>();
        core.addSink((event, payload) -> ui.add(event));
        core.addSink((event, payload) -> engine.add(event + ":" + payload.optString("event")));
        core.dispatchToSinks("connect", new JSONObject().put("event", "connect"));
        assertEquals(1, ui.size());
        assertEquals("connect:connect", engine.get(0));
    }

    @Test
    public void removingTheUiSinkLeavesTheSocketManagerAndOtherSinksAlive() throws Exception {
        List<String> engine = new ArrayList<>();
        SocketIOCore.EventSink ui = (event, payload) -> { };
        SocketIOCore.EventSink eng = (event, payload) -> engine.add(event);
        core.addSink(ui);
        core.addSink(eng);
        CapacitorSocketIO manager = core.plainManager();
        core.removeSink(ui); // what handleOnDestroy does now
        assertEquals(1, core.sinkCount());
        assertSame(manager, core.plainManager());
        core.dispatchToSinks("message", new JSONObject().put("event", "message"));
        assertEquals(1, engine.size());
    }

    @Test
    public void aSinkThatThrowsDoesNotStopTheOthers() throws Exception {
        List<String> seen = new ArrayList<>();
        core.addSink((event, payload) -> { throw new IllegalStateException("bad"); });
        core.addSink((event, payload) -> seen.add(event));
        core.dispatchToSinks("x", new JSONObject());
        assertEquals(1, seen.size());
    }

    @Test
    public void emitWithoutAConnectionRejectsThroughTheCallback() throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> message = new AtomicReference<>();
        core.emit("ping", new JSONObject(), null, new SocketIOCore.Callback() {
            @Override public void resolve(JSONObject result) { done.countDown(); }
            @Override public void reject(String m, Exception e) { message.set(m); done.countDown(); }
        });
        assertTrue(done.await(5, TimeUnit.SECONDS));
        assertNotNull(message.get());
        assertTrue(message.get().contains("not connected"));
    }

    @Test
    public void emitRequiresAnEventName() throws Exception {
        AtomicReference<String> message = new AtomicReference<>();
        core.emit(" ", null, null, new SocketIOCore.Callback() {
            @Override public void resolve(JSONObject result) { }
            @Override public void reject(String m, Exception e) { message.set(m); }
        });
        assertEquals("Event name is required", message.get());
    }

    @Test
    public void onRegistersInterestAndReportsListening() throws Exception {
        JSONObject result = core.on("job:done");
        assertEquals("listening", result.getString("status"));
        assertEquals("job:done", result.getString("event"));
    }

    @Test
    public void disconnectIsSafeWithNoSocketAndReportsDisconnected() throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> status = new AtomicReference<>();
        core.disconnect(new SocketIOCore.Callback() {
            @Override public void resolve(JSONObject result) { status.set(result.optString("status")); done.countDown(); }
            @Override public void reject(String m, Exception e) { done.countDown(); }
        });
        assertTrue(done.await(5, TimeUnit.SECONDS));
        assertEquals("disconnected", status.get());
        assertEquals(false, core.isUsingForegroundSession());
    }

    @Test
    public void drainBufferedEventsReturnsAnEventsArray() throws Exception {
        JSONObject drained = core.drainBufferedEvents(new JSONArray().put("job:done"));
        assertNotNull(drained.getJSONArray("events"));
    }

    // Device token stays out of the URL (proxies log query strings); it rides in the CONNECT auth packet.
    @Test
    public void authTokenGoesInAuthPacketNotUrlQuery() throws Exception {
        JSONObject options = new JSONObject()
            .put("auth", new JSONObject().put("token", "tok-123").put("clientVersion", "v1"))
            .put("query", new JSONObject().put("x", "1"));
        IO.Options opts = core.buildIoOptions("https://example.invalid", options);
        assertEquals("tok-123", opts.auth.get("token"));
        assertTrue(opts.query == null || !opts.query.contains("token"));
        assertTrue(opts.query != null && opts.query.contains("x=1"));
    }
}
