# @zenzig/capacitor-socket-io

A native Socket.IO bridge for Capacitor apps. Remove CORS headaches and talk directly to Socket.IO
servers from Android and iOS with a shared JavaScript API.

## Features

- 🔌 Native Socket.IO 2.x client with a drop-in Capacitor interface
- 🧵 Background thread handling so the UI never blocks during connect/emit calls
- 🔐 Optional trust-all SSL mode for development servers with self-signed certs
- 📡 Real-time event forwarding: subscribe once and receive everything in JavaScript
- 🌐 Web fallback that uses `socket.io-client` so your app behaves the same in the browser

## Installation

```bash
npm install @zenzig/capacitor-socket-io
npx cap sync
```

The sync step installs the native Android/iOS sources into your Capacitor project.

> Copy `.env.example` to `.env` and set `SOCKET_IO_PROXY_URL` to your HTTPS proxy so the helper
> scripts and verification commands can exercise a real Socket.IO endpoint.

## Quick start

```typescript
import { CapacitorSocketIO } from '@zenzig/capacitor-socket-io';

// 1. Register any events you care about **before** connecting.
const coreEvents = ['connect', 'disconnect', 'connect_error', 'pong'];
await CapacitorSocketIO.removeAllListeners();
await Promise.all(
	coreEvents.map(async (event) => {
		await CapacitorSocketIO.on({ event });
		await CapacitorSocketIO.addListener(event, ({ event: name, args }) => {
			console.log(`[socket] ${name}`, ...args);
		});
	}),
);

// 2. Connect to your Socket.IO server.
await CapacitorSocketIO.connect({
	url: 'https://socket-proxy.local',
	options: {
		path: '/socket.io',
		transports: ['websocket'],
		reconnection: true,
		allowSelfSigned: true, // Opt-in for dev/QA servers with self-signed TLS certificates
	},
});

// 3. Emit events.
await CapacitorSocketIO.emit({
	event: 'ping',
	data: { message: 'Hello from Capacitor' },
});

// 4. Disconnect when you are done.
await CapacitorSocketIO.disconnect();
```

> **Tip:** The dynamic `on({ event })` call must be invoked for every event you want to receive from
> the native layer (including custom events). Once registered, listeners added with
> `addListener(event, cb)` will fire for the lifetime of the socket until you call
> `removeAllListeners()`.

## API surface

| Method | Description |
| --- | --- |
| `connect(options?: ConnectOptions)` | Open (or reopen) a Socket.IO connection. Automatically resolves with `{ status: 'connecting', url }`. |
| `disconnect()` | Close the current socket and release native resources. |
| `emit(options: EmitOptions)` | Send data to the server. Supports `data` (object), `args` (array) or a single primitive value. |
| `on({ event })` | Ask the native layer to forward a specific event down to Capacitor listeners. Call this before `addListener`. |
| `addListener(eventName, callback)` | Subscribe to events (`connect`, custom messages, etc.). Returns a `PluginListenerHandle`. |
| `removeAllListeners()` | Clears all registered listeners in both native and web implementations. |

### Option reference

`ConnectOptions` mirrors the Socket.IO client settings:

| Name | Type | Notes |
| --- | --- | --- |
| `url` | `string` | Defaults to `https://socket-proxy.local/` if omitted. |
| `options.secure` | `boolean` | Force or disable TLS. Defaults based on the URL scheme. |
| `options.reconnection` | `boolean` | Toggle automatic reconnection. |
| `options.reconnectionAttempts` | `number` | Max retry count. |
| `options.timeout` | `number` | Connection timeout (ms). |
| `options.reconnectionDelay` | `number` | Initial reconnection delay (ms). |
| `options.reconnectionDelayMax` | `number` | Maximum reconnection delay (ms). |
| `options.path` | `string` | Override the Socket.IO namespace path (default `/socket.io`). |
| `options.query` | `Record<string, string> \\| string` | Query string params for the handshake. |
| `options.transports` | `string[]` | Transport whitelist (e.g. `['websocket']`). |
| `options.allowSelfSigned` | `boolean` | Android/iOS only. Trust all certificates—great for dev boxes, don’t enable in production. |

`EmitOptions` accepts either `data` or `args`:

```ts
await CapacitorSocketIO.emit({ event: 'chat:message', data: { body: 'hi' } });
await CapacitorSocketIO.emit({ event: 'sum', args: [1, 2, 3] });
```

## Example app

An interactive playground lives under `example-app/` and mirrors the plugin’s API. It is built with
Vite and ready for both web and native testing.

```bash
cd example-app
npm install
npm run dev
```

To launch the native demo on Android:

```bash
npx cap sync android
npx cap run android
```

The UI includes controls to connect, emit events, and view the forwarded event log in real time. It
defaults to `https://socket-proxy.local/` as a reminder to supply your own TLS proxy endpoint.

### Testing with a TLS Socket.IO proxy

Capacitor’s WebView inherits the same web security model as a browser, so proper end-to-end testing
requires a Socket.IO server that is reachable via HTTPS. We intentionally avoid shipping a hard-coded
endpoint—bring (or stand up) your own proxy instead:

1. Choose a hostname for your test environment (for example `socket-proxy.local`) and generate a
	trusted certificate with [mkcert](https://github.com/FiloSottile/mkcert) or your preferred PKI.
2. Stand up a Socket.IO server (Node, Phoenix, etc.) on an internal port such as
	`http://localhost:4000`.
3. Place an HTTPS reverse proxy in front of it (Nginx, Caddy, Traefik) that terminates TLS with your
	certificate and forwards to the upstream Socket.IO server.
4. Import the certificate authority into your Android emulator/iOS simulator or real devices so they
	trust the proxy.
5. Point the plugin, example app, and automated tests at the proxy hostname. The repository’s
	scripts read from `.env`, so update `SOCKET_IO_PROXY_URL` accordingly.

See [`docs/testing-with-proxy.md`](./docs/testing-with-proxy.md) for a walkthrough that includes
`mkcert` commands, sample proxy configuration, and extra tips for CI environments.

### Run the bundled proxy stack

For a quick bootstrap, the repository includes a Docker Compose stack under `docker/`:

```bash
# Generate certs with mkcert and place them in docker/certs/
cp .env.example .env  # adjust SOCKET_PROXY_HOST if desired
echo "127.0.0.1 socket-proxy.local" | sudo tee -a /etc/hosts
npm run proxy:up
```

The stack exposes HTTPS on port 443 and self-hosts the upstream Socket.IO test server. Shut it down
with `npm run proxy:down` and watch logs with `npm run proxy:logs`.

## Updating the generated docs

The README API table above is maintained manually for clarity. If you prefer the automatic docgen
output, update the JSDoc comments in `src/definitions.ts` and run:

```bash
npm run docgen
```

This regenerates the `README.md` API section and `dist/docs.json` based on the current plugin
signature.
