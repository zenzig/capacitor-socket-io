package com.zenzig.plugins.socketio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import io.socket.client.Ack;
import io.socket.client.IO;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

/**
 * Commit 7: emitWithAck. The ack path is driven through the {@link SocketIOCore.AckTransport} seam so the
 * ack / timeout / not-connected paths run on a plain JVM without a server. One gated test talks to a real server.
 */
public class EmitWithAckTest {

    /** Records every outcome so a test can assert "exactly one". */
    private static final class Outcome implements SocketIOCore.Callback {
        final AtomicInteger resolves = new AtomicInteger();
        final AtomicInteger rejects = new AtomicInteger();
        final AtomicReference<JSONObject> result = new AtomicReference<>();
        final AtomicReference<String> message = new AtomicReference<>();
        final AtomicReference<String> code = new AtomicReference<>();
        final CountDownLatch first = new CountDownLatch(1);

        @Override
        public void resolve(JSONObject r) {
            result.set(r);
            resolves.incrementAndGet();
            first.countDown();
        }

        @Override
        public void reject(String m, Exception e) {
            reject(m, null, e);
        }

        @Override
        public void reject(String m, String c, Exception e) {
            message.set(m);
            code.set(c);
            rejects.incrementAndGet();
            first.countDown();
        }

        int total() {
            return resolves.get() + rejects.get();
        }

        boolean await(long ms) throws InterruptedException {
            return first.await(ms, TimeUnit.MILLISECONDS);
        }
    }

    private SocketIOCore core;

    private static JSONObject okObject() {
        try {
            return new JSONObject().put("ok", true);
        } catch (org.json.JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    @Before
    public void setUp() {
        core = SocketIOCore.resetForTests();
    }

    @After
    public void tearDown() {
        core.setAckTransportForTests(null);
        core.destroy();
    }

    // ------------------------------------------------------------------------------------------- ack

    @Test
    public void anAckResolvesWithEveryAckArgumentAndCancelsTheTimer() throws Exception {
        List<Object[]> sent = Collections.synchronizedList(new ArrayList<>());
        core.setAckTransportForTests((event, payload, ack) -> {
            sent.add(new Object[] { event, payload });
            new Thread(() -> ack.call(okObject(), "second", 3)).start();
        });
        Outcome out = new Outcome();
        core.emitWithAck("job:submit", new JSONObject().put("a", 1), null, 5000, out);
        assertTrue(out.await(3000));

        assertEquals(1, out.resolves.get());
        assertEquals(0, out.rejects.get());
        JSONArray args = out.result.get().getJSONArray("args");
        assertEquals(3, args.length());
        assertEquals(true, args.getJSONObject(0).getBoolean("ok"));
        assertEquals("second", args.getString(1));
        assertEquals(3, args.getInt(2));
        assertEquals("job:submit", sent.get(0)[0]);
        // A 5 s timer must not be left behind once the ack has arrived.
        assertEquals(0, core.pendingAckTimers());
    }

    @Test
    public void anAckWithNoArgumentsResolvesWithAnEmptyArgsArray() throws Exception {
        core.setAckTransportForTests((event, payload, ack) -> new Thread(() -> ack.call()).start());
        Outcome out = new Outcome();
        core.emitWithAck("ping", null, null, 5000, out);
        assertTrue(out.await(3000));
        assertEquals(0, out.result.get().getJSONArray("args").length());
    }

    @Test
    public void argsWinOverDataAndDataIsWrappedInOneArgumentLikeEmit() throws Exception {
        List<Object[]> payloads = Collections.synchronizedList(new ArrayList<>());
        core.setAckTransportForTests((event, payload, ack) -> {
            payloads.add(payload);
            ack.call();
        });
        Outcome withData = new Outcome();
        JSONObject data = new JSONObject().put("k", "v");
        core.emitWithAck("e", data, null, 5000, withData);
        assertTrue(withData.await(3000));
        Outcome withArgs = new Outcome();
        core.emitWithAck("e", data, new JSONArray().put("x").put(2), 5000, withArgs);
        assertTrue(withArgs.await(3000));
        Outcome bare = new Outcome();
        core.emitWithAck("e", null, null, 5000, bare);
        assertTrue(bare.await(3000));

        assertEquals(1, payloads.get(0).length);
        assertEquals(data, payloads.get(0)[0]);
        assertEquals(2, payloads.get(1).length);
        assertEquals("x", payloads.get(1)[0]);
        assertEquals(0, payloads.get(2).length);
    }

    // --------------------------------------------------------------------------------------- timeout

    @Test
    public void noAckInTimeRejectsAckTimeoutExactlyOnceAndALateAckIsIgnored() throws Exception {
        AtomicReference<Ack> captured = new AtomicReference<>();
        core.setAckTransportForTests((event, payload, ack) -> captured.set(ack));
        Outcome out = new Outcome();
        long started = System.nanoTime();
        core.emitWithAck("slow", null, null, 120, out);
        assertTrue(out.await(3000));
        long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);

        assertEquals("ACK_TIMEOUT", out.code.get());
        assertNotNull(out.message.get());
        assertTrue("rejected too early: " + elapsedMs, elapsedMs >= 100);
        assertNotNull(captured.get());
        captured.get().call("too late");
        Thread.sleep(150);
        assertEquals(1, out.total());
        assertEquals(0, out.resolves.get());
        assertEquals(0, core.pendingAckTimers());
    }

    @Test
    public void ackAndTimeoutRacingNeverSettleTwice() throws Exception {
        final int rounds = 300;
        List<Outcome> outcomes = new ArrayList<>();
        core.setAckTransportForTests((event, payload, ack) -> new Thread(() -> {
            try {
                Thread.sleep(4); // lands within a millisecond or two of the 5 ms timer
            } catch (InterruptedException ignore) {
                // test thread teardown
            }
            ack.call("late-or-not");
        }).start());
        for (int i = 0; i < rounds; i++) {
            Outcome out = new Outcome();
            outcomes.add(out);
            core.emitWithAck("race", null, null, 5, out);
        }
        for (Outcome out : outcomes) {
            assertTrue(out.await(5000));
        }
        Thread.sleep(300); // let every straggler (second settle attempt) land
        int acked = 0;
        int timedOut = 0;
        for (Outcome out : outcomes) {
            assertEquals("exactly one outcome per call", 1, out.total());
            if (out.resolves.get() == 1) acked++;
            else {
                timedOut++;
                assertEquals("ACK_TIMEOUT", out.code.get());
            }
        }
        assertEquals(rounds, acked + timedOut);
        assertEquals(0, core.pendingAckTimers());
    }

    // --------------------------------------------------------------------------------- not connected

    @Test
    public void aTransportThatReportsNotConnectedRejectsNotConnectedAndLeavesNoTimer() throws Exception {
        core.setAckTransportForTests((event, payload, ack) -> {
            throw new CapacitorSocketIO.NotConnectedException();
        });
        Outcome out = new Outcome();
        core.emitWithAck("x", null, null, 5000, out);
        assertTrue(out.await(3000));
        assertEquals("NOT_CONNECTED", out.code.get());
        assertEquals(1, out.total());
        assertEquals(0, core.pendingAckTimers());
    }

    @Test
    public void withNoSocketAtAllTheRealTransportRejectsNotConnected() throws Exception {
        Outcome out = new Outcome();
        core.emitWithAck("x", null, null, 5000, out);
        assertTrue(out.await(3000));
        assertEquals("NOT_CONNECTED", out.code.get());
        assertEquals(1, out.total());
    }

    @Test
    public void aSocketThatExistsButIsNotConnectedYetAlsoRejectsNotConnected() throws Exception {
        CapacitorSocketIO manager = new CapacitorSocketIO();
        try {
            IO.Options opts = new IO.Options();
            opts.reconnection = false;
            opts.forceNew = true;
            manager.connect("http://127.0.0.1:1/", opts); // creates the socket, handshake never completes
            assertThrows(
                CapacitorSocketIO.NotConnectedException.class,
                () -> manager.emitWithAck("x", new Object[0], args -> { })
            );
        } finally {
            manager.destroy();
        }
        assertThrows(
            CapacitorSocketIO.NotConnectedException.class,
            () -> new CapacitorSocketIO().emitWithAck("x", new Object[0], args -> { })
        );
    }

    @Test
    public void notConnectedIsAnIllegalStateExceptionSoOldCatchersStillWork() {
        assertTrue(new CapacitorSocketIO.NotConnectedException() instanceof IllegalStateException);
    }

    // ------------------------------------------------------------------------------------ bad input

    @Test
    public void aMissingOrBlankEventRejectsInvalidArgumentWithoutTouchingTheSocket() throws Exception {
        AtomicInteger touched = new AtomicInteger();
        core.setAckTransportForTests((event, payload, ack) -> touched.incrementAndGet());
        for (String bad : new String[] { null, "", "   " }) {
            Outcome out = new Outcome();
            core.emitWithAck(bad, null, null, 5000, out);
            assertTrue(out.await(3000));
            assertEquals("INVALID_ARGUMENT", out.code.get());
            assertEquals("Event name is required", out.message.get());
        }
        assertEquals(0, touched.get());
    }

    @Test
    public void aBadTimeoutRejectsInvalidArgumentWithoutTouchingTheSocket() throws Exception {
        AtomicInteger touched = new AtomicInteger();
        core.setAckTransportForTests((event, payload, ack) -> touched.incrementAndGet());
        Object[] bad = { 0, -5, "abc", Double.NaN, Double.POSITIVE_INFINITY, Boolean.TRUE, new JSONObject() };
        for (Object timeout : bad) {
            Outcome out = new Outcome();
            core.emitWithAck("e", null, null, timeout, out);
            assertTrue("timeout " + timeout, out.await(3000));
            assertEquals("timeout " + timeout, "INVALID_ARGUMENT", out.code.get());
            assertEquals(1, out.total());
        }
        assertEquals(0, touched.get());
    }

    @Test
    public void theDefaultTimeoutIsTenSecondsAndAppliesWhenTheCallerSendsNone() {
        assertEquals(10_000L, SocketIOCore.DEFAULT_ACK_TIMEOUT_MS);
        assertEquals(10_000L, SocketIOCore.parseAckTimeout(null));
        assertEquals(10_000L, SocketIOCore.parseAckTimeout(JSONObject.NULL));
        assertEquals(2500L, SocketIOCore.parseAckTimeout(2500));
        assertEquals(2500L, SocketIOCore.parseAckTimeout(2500.0));
        assertEquals(3L, SocketIOCore.parseAckTimeout(2.2)); // fractions round up, never to zero
    }

    @Test
    public void aTransportFailureThatIsNotNotConnectedRejectsEmitFailed() throws Exception {
        core.setAckTransportForTests((event, payload, ack) -> {
            throw new RuntimeException("boom");
        });
        Outcome out = new Outcome();
        core.emitWithAck("x", null, null, 5000, out);
        assertTrue(out.await(3000));
        assertEquals("EMIT_FAILED", out.code.get());
        assertEquals(0, core.pendingAckTimers());
    }

    @Test
    public void theTwoArgumentRejectStillWorksForOldCallbacks() throws Exception {
        AtomicReference<String> message = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        // An implementer written before commit 7 only has resolve + the two-argument reject.
        SocketIOCore.Callback legacy = new SocketIOCore.Callback() {
            @Override public void resolve(JSONObject r) { }
            @Override public void reject(String m, Exception e) { message.set(m); done.countDown(); }
        };
        core.emitWithAck("e", null, null, 0, legacy);
        assertTrue(done.await(3, TimeUnit.SECONDS));
        assertNotNull(message.get());
    }

    // ------------------------------------------------------------------------------------ real server

    /**
     * Talks to a real Socket.IO server that acks {@code ack-echo} with its first argument and never acks
     * {@code ack-never}. Set SOCKET_IO_ACK_SERVER_URL (for example http://127.0.0.1:PORT/) to run it.
     */
    @Test
    public void realServerAckAndTimeout() throws Exception {
        String url = System.getenv("SOCKET_IO_ACK_SERVER_URL");
        Assume.assumeTrue("Set SOCKET_IO_ACK_SERVER_URL to run the real-server ack test.", url != null && !url.trim().isEmpty());

        CountDownLatch connected = new CountDownLatch(1);
        core.plainManager().setEventListener((event, args) -> {
            if ("connect".equals(event)) connected.countDown();
        });
        Outcome connect = new Outcome();
        core.connect(url, new JSONObject(), connect);
        assertTrue(connect.await(5000));
        assertTrue("socket should connect", connected.await(10, TimeUnit.SECONDS));

        Outcome echo = new Outcome();
        core.emitWithAck("ack-echo", new JSONObject().put("n", 7), null, 5000, echo);
        assertTrue(echo.await(5000));
        assertEquals(7, echo.result.get().getJSONArray("args").getJSONObject(0).getInt("n"));

        Outcome never = new Outcome();
        core.emitWithAck("ack-never", null, null, 300, never);
        assertTrue(never.await(5000));
        assertEquals("ACK_TIMEOUT", never.code.get());
    }
}
