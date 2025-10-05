# Testing with a TLS Socket.IO proxy

A real Socket.IO deployment typically sits behind an HTTPS boundary. Because the plugin’s goal is to
match production behaviour, run your verification against a proxy that terminates TLS and forwards to
a Socket.IO server. This guide explains one way to assemble that environment on macOS, Linux, or
Windows.

## Overview

1. Generate a trusted certificate for a development hostname (for example `socket-proxy.local`).
2. Launch a Socket.IO server instance that listens on HTTP (or a UNIX domain socket).
3. Configure a reverse proxy such as Nginx or Caddy to terminate TLS and forward traffic to the
   upstream Socket.IO server.
4. Import the certificate authority into the Android emulator/iOS simulator (or physical devices).
5. Point the plugin, example app, and automated tests to the proxy hostname.

The steps below use [`mkcert`](https://github.com/FiloSottile/mkcert) because it generates
certificates that are trusted by local development tooling without creating global CA entries.
Substitute your organisation’s internal CA or another PKI solution if preferred.

## Quick start with Docker Compose

Prefer a ready-made environment? This repository ships a Docker stack that launches an upstream
Socket.IO server and an HTTPS reverse proxy. Run `npm run proxy:setup` from the repo root to
generate certificates with mkcert, normalise `.env`, and bring the stack up automatically (ensure
Docker is running first). Append `--host dev.example.com` to use a different hostname, `--port 4443`
if 443 is already taken locally, or `--no-start` if you only want the certificates and `.env`
updates without launching Docker. The script inspects active listeners and prints whichever process
currently owns a conflicting port so you can resolve the clash quickly. Under the hood the script
performs the following steps (you can run them manually if you prefer):

1. Generate certificates for `socket-proxy.local` (steps below) and drop them into
  `docker/certs/` as `socket-proxy.pem` (certificate chain) and `socket-proxy-key.pem` (private
  key). You can direct `mkcert` to write the files to that directory in one step:

  ```bash
  mkcert \
    -cert-file docker/certs/socket-proxy.pem \
    -key-file docker/certs/socket-proxy-key.pem \
    socket-proxy.local "*.socket-proxy.local"
  ```
2. Map the hostname to your machine’s LAN IP in the hosts file (for example `192.168.0.28 socket-proxy.local`). You can add it manually or let `npm run proxy:setup --write-hosts` try to update `/etc/hosts` for you (macOS/Linux; prompts for sudo if needed). On Windows, run an elevated editor and add the entry manually.
3. Copy `.env.example` to `.env` (the setup script handles this) and set `SOCKET_PROXY_HOST` /
  `SOCKET_IO_PROXY_URL` if you prefer a different hostname.
4. Start the stack from the repo root:

  ```bash
  npm run proxy:up
  ```

5. When finished, stop it with `npm run proxy:down`. Use `npm run proxy:logs` to tail Nginx output.

The remainder of this guide explains the pieces in detail; you can follow it manually or treat it as
reference when customising the container setup.

## 1. Create a trusted certificate

```bash
# Install mkcert once
brew install mkcert
mkcert -install

# Create a cert/key pair for the dev proxy
mkcert socket-proxy.local "*.socket-proxy.local"
```

The command above emits `socket-proxy.local+1.pem` (certificate) and `socket-proxy.local+1-key.pem`
(private key) in the current directory unless you override the output paths with `-cert-file` /
`-key-file` (as shown in the Docker quick start). Store them somewhere convenient, such as
`~/.config/socket-proxy/`, or copy them into `docker/certs/` when you plan to run the container
stack. When rotating certs, delete any stale files from `docker/certs/` so the proxy reloads the
fresh pair.

> **Tip:** If you already manage certificates elsewhere, reuse that pipeline instead of mkcert.
> Production builds must present a certificate signed by a trusted CA or a key you pin explicitly;
> `allowSelfSigned` is rejected outside debug builds.

## 2. Run a Socket.IO upstream server

Any Socket.IO implementation will work. Here’s a minimal Node server that responds to `ping` events
and echoes everything else to connected clients.

```bash
npm init -y
npm install socket.io@4
```

```js
// save as socket-server.mjs
import { createServer } from 'http';
import { Server } from 'socket.io';

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: '*' },
  path: '/socket.io'
});

io.on('connection', (socket) => {
  console.log(`[upstream] client ${socket.id} connected`);

  socket.on('ping', (payload) => {
    console.log('[upstream] ping', payload);
    socket.emit('pong', { ok: true, received: payload });
  });

  socket.onAny((event, ...args) => {
    console.log(`[upstream] event=${event}`, args);
  });
});

httpServer.listen(4000, () => {
  console.log('Socket.IO upstream listening on http://localhost:4000');
});
```

Run it with `node socket-server.mjs`.

## 3. Configure a TLS reverse proxy

Create an Nginx configuration (or equivalent) that terminates TLS and forwards the WebSocket channel
to the upstream server.

```nginx
# /usr/local/etc/nginx/servers/socket-proxy.conf
server {
    listen              443 ssl;
    server_name         socket-proxy.local;

    ssl_certificate     /path/to/socket-proxy.local+1.pem;
    ssl_certificate_key /path/to/socket-proxy.local+1-key.pem;

    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location /socket.io/ {
        proxy_pass          http://127.0.0.1:4000/socket.io/;
        proxy_http_version  1.1;
        proxy_set_header    Upgrade $http_upgrade;
        proxy_set_header    Connection "Upgrade";
        proxy_set_header    Host $host;
    }
}
```

Restart Nginx (`sudo nginx -s reload`). Caddy or Traefik can be configured similarly.

## 4. Trust the certificate on test devices

- **Android emulator:** drag the `socket-proxy.local+1.pem` file onto the emulator window, choose
  *VPN and app user certificate*, and reboot the emulator. For physical devices, follow the Android
  documentation for installing user certificates.
- **iOS simulator:** add the `.pem` file to the simulator via drag-and-drop, then open *Settings →
  General → About → Certificate Trust Settings* and enable full trust for the certificate.
- **iOS device:** deliver the certificate via AirDrop or MDM and approve it under *Settings → General
  → About → Certificate Trust Settings*.

## 5. Point tooling at the proxy

Copy `.env.example` to `.env` and record the proxy hostname so every script runs with the same
configuration. The helper utilities automatically load values from `.env` via `dotenv`.

Set the proxy URL in each place you integrate with the plugin:

- **Plugin calls:** pass `url: 'https://socket-proxy.local'` to `CapacitorSocketIO.connect()`.
- **Android unit tests:** set `SOCKET_IO_PROXY_URL` in `.env` (or export it manually) before running
  `npm run verify:android`.
- **Example app:** update the Server URL field from its placeholder to your proxy hostname—or set
  `VITE_SOCKET_PROXY_URL` in `.env`. When the proxy runs on a LAN IP that differs from the hostname
  in your certificate, also set `ANDROID_PROXY_LAN_IP` so the Android launcher script writes an entry
  to `/system/etc/hosts` before installing the app:

  ```env
  SOCKET_PROXY_PORT=443
  VITE_SOCKET_PROXY_URL=https://socket-proxy.local
  ANDROID_PROXY_LAN_IP=192.168.0.28
  ```
- **Helper scripts:** populate `SOCKET_IO_PROXY_URL` in `.env` for `scripts/test-socket.js` /
  `test-socket.mjs`.

If you pick a non-default port, append it to the URLs above—for example
`VITE_SOCKET_PROXY_URL=https://socket-proxy.local:4443`.

Per-platform overrides were previously required for emulators; the launcher script now handles host
mapping automatically when `ANDROID_PROXY_LAN_IP` is present.

> **Consistency check:** Whatever hostname your certificate covers must match `SOCKET_PROXY_HOST`
> and `SOCKET_IO_PROXY_URL`. If you issue a new cert for a different host, update `.env` and remove
> any stale cert/key pairs from `docker/certs/` so the Docker proxy mounts the correct files.

> **Android emulators:** When your proxy runs on the host machine (for example listening on
> `192.168.0.28`), the launcher script adds a hosts entry automatically if `ANDROID_PROXY_LAN_IP`
> is provided. To apply the mapping manually (or on older builds):
>
> ```bash
> adb root
> adb remount
> adb shell "echo '192.168.0.28 socket-proxy.local' >> /system/etc/hosts"
> adb reboot
> ```
>
> After the reboot, install the development certificate authority on the emulator so TLS handshakes
> succeed. Apply an equivalent mapping on physical devices via Wi-Fi advanced settings, and ensure
> the certificate authority is trusted system-wide.

> **AVD tip:** Choose a *Google APIs* system image (avoid Google Play Store images) for test AVDs.
> These builds allow `/system` to be remounted. The `npm run test:android` script launches emulators
> with `-writable-system`; existing emulators must be restarted with that flag for automatic host
> mapping.

## Production hardening tips

- **Pin certificates or public keys** using Android Network Security Config and iOS ATS overrides
  if you terminate TLS on infrastructure you control. Prefer SPKI pinning so renewals are easier.
- Rotate pins ahead of time—ship overlapping pins for the new and old certificates before a swap.
- Keep the TLS proxy behind automation that renews certificates (Let’s Encrypt, step-ca, Vault,
  ACME) and push updated certs to your mobile apps through configuration rather than code changes.
- Treat `allowSelfSigned` as a development-only escape hatch. The native plugins enforce this at
  runtime but it’s still good practice to gate the flag behind build-time settings.

## FAQ

**Why not bundle a hosted test server?**

A shared endpoint often encourages developers to skip the TLS setup entirely, which hides the very
problem this plugin solves. Running your own proxy ensures both mobile platforms are talking to a
server that mirrors production constraints.

**Can I automate this in CI?**

Yes. Provision certificates via your CI secret store, spin up the Socket.IO upstream and proxy using
Docker (two services), and expose the proxy container on `https://socket-proxy` within the CI
network. Export `SOCKET_IO_PROXY_URL=https://socket-proxy` before invoking the test suite.

**Do I have to use Nginx?**

Any HTTPS reverse proxy works. Caddy and Traefik have simpler configuration syntaxes and can issue
local certificates automatically, but Nginx remains the most widely available option.
