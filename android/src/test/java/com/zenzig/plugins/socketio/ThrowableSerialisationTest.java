package com.zenzig.plugins.socketio;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;

public class ThrowableSerialisationTest {

    @Test
    public void websocketErrorKeepsTheCauseChain() {
        Exception root = new java.net.SocketException("Software caused connection abort");
        Exception mid = new RuntimeException("io failure", root);
        Exception top = new Exception("websocket error", mid);
        JSONObject json = CapacitorSocketIOPlugin.throwableToJson(top);
        assertEquals("java.lang.Exception: websocket error", json.optString("message"));
        assertEquals(
            "java.lang.RuntimeException: io failure <- java.net.SocketException: Software caused connection abort",
            json.optString("cause")
        );
        assertEquals("Exception", json.optString("type"));
    }

    @Test
    public void noCauseGivesEmptyChain() {
        JSONObject json = CapacitorSocketIOPlugin.throwableToJson(new IllegalStateException("x"));
        assertEquals("", json.optString("cause"));
    }

    @Test
    public void managerReconnectEventsAreTheOnesForwarded() {
        assertEquals(4, CapacitorSocketIO.MANAGER_EVENTS.length);
    }
}
