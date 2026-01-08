## Capacitor Socket.IO Example App

This app demonstrates the `@zenzig/capacitor-socket-io` plugin running on iOS, Android, and web.

> Want to see it in action first? Check the "Gallery" section in the repository root `README.md` for
> screenshots of the iOS, Android, and proxy experiences running side by side.

### Running this example

The example consumes the plugin from the parent directory (`"@zenzig/capacitor-socket-io": "file:.."`).
Install the plugin dependencies and build its `dist/` output from the repository root first. Then install
the example app dependencies:

```bash
# from the repository root
npm install

cd example-app
npm install
npm run build
```

Sync the native projects so they pick up the latest `@zenzig/capacitor-socket-io` build:

```bash
npx cap sync ios android
```

### Starting the proxy

The example app connects to `https://socket-proxy.local/` by default. Start the bundled Docker proxy:

```bash
# from the repository root
npm run proxy:setup -- --write-hosts
```

This starts a Caddy reverse proxy with automatic TLS, updates your hosts file, and configures `.env`.

Visit `https://socket-proxy.local/` in your browser to open the matching web console. It shares
the same Socket.IO session as the native app so you can observe broadcasts, presence updates, and
ping/pong traffic across all clients.

### Self-Signed Certificates

The example app enables **"Allow Untrusted Certs"** by default for development. This means:

- **No certificate installation required** on emulators or simulators
- The app connects to self-signed HTTPS endpoints without manual trust configuration
- This option is automatically disabled in production builds

For production, your server must present a valid CA-signed certificate.

### Running on iOS

Launch the interactive simulator picker:

```bash
npm run test:ios
```

Or from the example-app directory:

```bash
npm run ios
```

### Running on Android

Launch an emulator or choose a connected device:

```bash
npm run test:android
```

Or from the example-app directory:

```bash
npm run android
```

> **Emulator requirement:** Use a Google APIs system image (not Google Play Store) so the Android
> SDK allows `/system/etc/hosts` to be remounted read/write. The launcher starts emulators with
> `-writable-system` automatically. If you bring your own running emulator, restart it with
> `emulator -avd <name> -writable-system` before running the script.

### Running on Web

```bash
npm run dev
```

Then open `http://localhost:5173/` in your browser.

### Configuration

Set these environment variables in the root `.env` file:

| Variable | Description |
| --- | --- |
| `VITE_SOCKET_PROXY_URL` | The HTTPS endpoint for the Socket.IO proxy |
| `ANDROID_PROXY_LAN_IP` | LAN IP for Android emulator host mapping |

The `npm run proxy:setup` command configures these automatically.
