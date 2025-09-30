package com.zenzig.plugins.socketio;

import com.getcapacitor.Logger;

public class CapacitorSocketIO {

    public String echo(String value) {
        Logger.info("Echo", value);
        return value;
    }
}
