package com.example.plugin;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.zenzig.plugins.socketio.CapacitorSocketIOPlugin;

public class MainActivity extends BridgeActivity {
	@Override
	protected void onCreate(Bundle savedInstanceState) {
		registerPlugin(CapacitorSocketIOPlugin.class);
		super.onCreate(savedInstanceState);
	}
}
