import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Android foreground socket service contract', () => {
  it('declares a foreground service for persistent Socket.IO sessions', () => {
    const manifest = read('android/src/main/AndroidManifest.xml');

    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE');
    expect(manifest).toContain('com.zenzig.plugins.socketio.SocketIOForegroundService');
    expect(manifest).toContain('android:foregroundServiceType="dataSync"');
  });

  it('exposes foreground service and buffered event APIs to TypeScript callers', () => {
    const definitions = read('src/definitions.ts');

    expect(definitions).toContain('SocketIOForegroundServiceOptions');
    expect(definitions).toContain('foregroundService?: boolean | SocketIOForegroundServiceOptions');
    expect(definitions).toContain('drainBufferedEvents');
    expect(definitions).toContain('isForegroundServiceRunning');
  });

  it('routes foreground service events through a native event buffer', () => {
    const plugin = read('android/src/main/java/com/zenzig/plugins/socketio/CapacitorSocketIOPlugin.java');
    const service = read('android/src/main/java/com/zenzig/plugins/socketio/SocketIOForegroundService.java');
    const session = read('android/src/main/java/com/zenzig/plugins/socketio/SocketIOForegroundSession.java');

    expect(plugin).toContain('drainBufferedEvents');
    expect(plugin).toContain('isForegroundServiceRunning');
    expect(plugin).toContain('foregroundService');
    expect(service).toContain('startForeground');
    expect(session).toContain('bufferedEvents');
    expect(session).toContain('drainBufferedEvents');
  });
});
