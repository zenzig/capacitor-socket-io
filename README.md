# @zenzig/capacitor-socket-io

A native Socket.IO bridge for Capacitor apps. Remove CORS headaches and talk directly to Socket.IO
servers from Android and iOS with a shared JavaScript API.

## Features

- 🔌 Native Socket.IO clients aligned with the Socket.IO 4.x protocol (Android Java client 2.1.1 / iOS Swift client 16.1.x)
- 🧵 Background thread handling so the UI never blocks during connect/emit calls
- 🔐 Debug-only trust-all SSL mode for development servers with self-signed certs
- 📡 Real-time event forwarding: subscribe once and receive everything in JavaScript
- 🌐 Web fallback that uses `socket.io-client` so your app behaves the same in the browser

## Installation

Until the package is published on npm, install it straight from this repository (pin to the
`main` branch or a specific commit/tag).

```bash
npm install github:zenzig/capacitor-socket-io#main
npx cap sync
```

Prefer working from a local clone? Run `npm pack` in this repo after `npm run build`, then install
the generated tarball in your Capacitor app (`npm install ../capacitor-socket-io/capacitor-socket-io-*.tgz`).
We’ll update these instructions once the plugin is available on the npm registry.

The sync step installs the native Android/iOS sources into your Capacitor project.

> Copy `.env.example` to `.env` and set `SOCKET_IO_PROXY_URL` to your HTTPS proxy so the helper
> scripts and verification commands can exercise a real Socket.IO endpoint.

## Quick start

Follow these steps to exercise the plugin using the bundled Docker proxy and the example app.

1. **Install dependencies (root):**

	```bash
	npm install
	```

2. **Launch the HTTPS proxy:**

	```bash
	npm run proxy:setup -- --write-hosts
	```

	This command:

	- generates/refreshes mkcert certificates under `docker/certs/`
	- updates `.env` with `SOCKET_PROXY_HOST`, `SOCKET_IO_PROXY_URL`, `VITE_SOCKET_PROXY_URL`, and a detected `ANDROID_PROXY_LAN_IP`
	- rewrites `/etc/hosts` (on macOS/Linux) so only one entry for `socket-proxy.local` remains, then starts the Docker proxy stack detached

	Add `--no-start` if you only want to refresh certificates and `.env`, or `--port 4443` / `--host dev.example.com` to customise the endpoint.

3. **Build and sync the example app:**

	```bash
	cd example-app
	npm install
	npm run build
	npx cap sync android ios
	```

4. **Run the Android demo (auto host-mapping included):**

	```bash
	npm run test:android
	```

	The launcher boots/targets an emulator or device, ensures `/system/etc/hosts` contains a single mapping for `socket-proxy.local`, installs the app, and connects to the proxy.

5. **Optional – run on iOS:**

	```bash
	npm run test:ios
	```

That’s it—you now have a native client talking to the Socket.IO test server exposed by Docker. Keep the proxy running while iterating; when you’re done, stop it with `npm run proxy:down`.

> **Using the plugin directly:** Once the proxy is up, you can import the plugin in your own app and point `CapacitorSocketIO.connect({ url: process.env.VITE_SOCKET_PROXY_URL })` at the generated HTTPS endpoint. Remember to call `CapacitorSocketIO.on({ event })` before adding listeners for each event you care about.

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
| `options.allowSelfSigned` | `boolean` | Android/iOS only. Trust-all certificates for development builds. **Rejected at runtime** for production/distribution builds. |

`EmitOptions` accepts either `data` or `args`:

```ts
await CapacitorSocketIO.emit({ event: 'chat:message', data: { body: 'hi' } });
await CapacitorSocketIO.emit({ event: 'sum', args: [1, 2, 3] });
```

## Example app

An interactive playground lives under `example-app/`. It mirrors the plugin’s API, ships with a
Socket.IO server contract test, and backs the native demo launched in the quick start. The build and
sync commands in step 3 above prepare both Android and iOS projects; rerun them whenever you change
the plugin source.

- **Run the web preview:** `npm run dev` (Vite dev server, reads `VITE_SOCKET_PROXY_URL`).
- **Rebuild after plugin edits:** `npm run build` to compile the Capacitor plugin and refresh the
	native projects.
- **Regenerate native projects:** `npx cap sync android ios` if you touch Capacitor config, add
	platforms, or upgrade dependencies.

The Android launcher (`npm run test:android`) and iOS launcher (`npm run test:ios`) both:

1. Load proxy settings from the repository root `.env`.
2. Ensure a single `socket-proxy.local` entry exists on the device/emulator by rewriting the hosts
	 file via the shared helper.
3. Install the app bundle and connect to the HTTPS proxy started earlier.

You rarely need to touch `/etc/hosts` manually now. Only follow the steps below if you are
debugging a device that prevents remounting or you are experimenting with a custom hostname/port.

```bash
adb root
adb remount
adb shell "echo '192.168.0.28 socket-proxy.local' >> /system/etc/hosts"
adb reboot
```

> **Custom port:** If you run the proxy on a port other than 443, append it to `VITE_SOCKET_PROXY_URL`
> (e.g. `https://socket-proxy.local:4443`) and restart the proxy plus the launcher.

> **Emulator images:** Pick a *Google APIs* system image (avoid Google Play Store images) so the
> launcher can remount `/system` read/write. It boots new emulators with `-writable-system`, but
> pre-existing emulators must be restarted with that flag for the automatic host mapping to succeed.

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
	scripts read from `.env`, so update `SOCKET_IO_PROXY_URL` (for helper scripts) and
	`VITE_SOCKET_PROXY_URL` (for the example app) accordingly.

See [`docs/testing-with-proxy.md`](./docs/testing-with-proxy.md) for a walkthrough that includes
`mkcert` commands, sample proxy configuration, and extra tips for CI environments.

### Certificate pinning & production guidance

- **Never rely on `allowSelfSigned` in production.** The plugin enforces this at runtime and will
	throw if a release build attempts to enable it.
- Adopt one of the following strategies in production builds:
	- Use certificates issued by a trusted public CA (Let’s Encrypt, DigiCert, etc.).
	- Pin the proxy’s certificate chain or public key using the platform facilities (e.g. Android
		Network Security Config, iOS ATS with `NSURLSession` delegate or configuration profiles).
- When pinning, prefer **SPKI/public-key pinning** over full certificate pinning to tolerate routine
	renewals. Rotate pins alongside certificate rollouts.
- Keep certificates short-lived and automate renewals. When pinning, ship overlapping pins to avoid
	downtime during rotation.

### Client versions & compatibility

| Platform | Package | Version | Notes |
| --- | --- | --- | --- |
| Android | `io.socket:socket.io-client` | `2.1.1` | Compatible with Socket.IO server 4.x. Excludes bundled `org.json` to avoid conflicts. |
| iOS | `Socket.IO-Client-Swift` | `16.1.1` | Aligned with Socket.IO server 4.x. Distributed via SwiftPM and CocoaPods. |
| Web | `socket.io-client` | `^4.x` | Pulled indirectly through bundlers when using web fallback. |

We track upstream releases and bump these dependencies alongside major server protocol updates.
Breaking changes will be called out in the changelog together with migration steps.

### Run the bundled proxy stack

For a quick bootstrap, the repository includes a Docker Compose stack under `docker/`. The fastest
path is:

```bash
npm run proxy:setup -- --write-hosts
```

The setup script checks for mkcert, generates `docker/certs/socket-proxy.pem`, normalises `.env`,
rewrites `/etc/hosts` so only one entry for `socket-proxy.local` remains, and starts the containers
detached. Ensure the Docker daemon is running beforehand. Prefer to run steps manually (or on a host
without Docker)? Append `--no-start` to skip launching the containers, and start them later with
`npm run proxy:up`. Need a different hostname? Add `--host dev.example.com`. Port 443 already taken
locally? Use `--port 4443` (or another free port); the script updates `.env`, rewrites the proxy URL
with the new port, and passes it to Docker Compose. Skip the hosts rewrite with `--no-write-hosts`
if you are managing entries yourself.

The stack exposes HTTPS on the port you choose (defaults to 443) and self-hosts the upstream
Socket.IO test server. Shut it down with `npm run proxy:down` and watch logs with
`npm run proxy:logs`.

## Updating the generated docs

The README API table above is maintained manually for clarity. If you prefer the automatic docgen
output, update the JSDoc comments in `src/definitions.ts` and run:

```bash
npm run docgen
```

This regenerates the `README.md` API section and `dist/docs.json` based on the current plugin
signature.
