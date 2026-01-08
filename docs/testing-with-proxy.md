# Testing with a TLS Socket.IO Proxy

A real Socket.IO deployment typically sits behind an HTTPS boundary. This guide explains how to
set up a local TLS proxy for testing the plugin.

## Overview

1. Launch a Caddy reverse proxy (with automatic certificate generation) and Socket.IO upstream server
2. Point the plugin, example app, and automated tests to the proxy hostname

The bundled Docker stack handles this automatically. Caddy generates certificates for any domain
name—including made-up ones like `socket-proxy.local`—using its internal Certificate Authority.

## Quick Start

```bash
npm run proxy:setup -- --write-hosts
```

This command:
1. Creates `.env` from `.env.example` if missing
2. Detects your LAN IP and updates `.env` variables
3. Updates `/etc/hosts` with the LAN IP mapping
4. Starts the Docker stack with Caddy + Socket.IO server
5. Installs Caddy's root CA on macOS

## Self-Signed Certificate Handling

The example app enables **"Allow Untrusted Certs"** by default for development:

- **No certificate installation required** on emulators or simulators
- The app connects to self-signed HTTPS endpoints automatically
- This option is disabled in production builds

This means you can run `npm run test:android` or `npm run test:ios` immediately after starting
the proxy—no manual trust configuration needed.

## Setup Options

| Flag | Description |
|------|-------------|
| `--host <hostname>` | Override the proxy hostname (default: `socket-proxy.local`) |
| `--port <port>` | Override the HTTPS port (default: `443`) |
| `--write-hosts` | Auto-update `/etc/hosts` with LAN IP mapping |
| `--no-start` | Configure `.env` only, don't start Docker |
| `--reset-ca` | Remove Caddy's CA volume before starting |

## Manual Setup Steps

1. Map the hostname to your machine's LAN IP in `/etc/hosts`:
   ```bash
   192.168.0.28 socket-proxy.local
   ```
   Or run `npm run proxy:setup --write-hosts` to do this automatically.

2. Start the stack:
   ```bash
   npm run proxy:up
   ```

3. Check readiness:
   ```bash
   curl -k https://socket-proxy.local/healthz
   ```

4. Stop when finished:
   ```bash
   npm run proxy:down
   ```

Use `npm run proxy:logs` to tail Caddy output.

## Android Emulator Requirements

> **Important:** Use a Google APIs system image (not Google Play Store) so the Android SDK
> allows `/system/etc/hosts` to be remounted read/write.

The launcher starts emulators with `-writable-system` automatically. If you bring your own
running emulator, restart it with:

```bash
emulator -avd <name> -writable-system
```

The host mapping (`socket-proxy.local` → LAN IP) is handled automatically by `npm run test:android`.

## End-to-End Testing

Once the proxy is running:

1. Install example app dependencies (once per clone):
   ```bash
   npm run example:install
   ```

2. Run the multi-platform suite:
   ```bash
   npm run test:e2e
   ```

   This runs Android JVM tests, iOS Swift package tests, and Playwright browser journeys.
   Artifacts land under `playwright-report/`.

3. For browser tests only:
   ```bash
   npm run test:e2e:web
   ```

## JWT Authentication (Optional)

Set these variables in `.env` before starting the stack:

- `SOCKET_SERVER_AUTH_SECRET` – raw signing secret
- `SOCKET_SERVER_AUTH_PASSPHRASE` plus optional `SOCKET_SERVER_AUTH_SALT`

Clients send the JWT via `auth.token`, a `token` query parameter, or `Authorization: Bearer <token>`.

## Production Mode

To use Let's Encrypt/ZeroSSL instead of Caddy's internal CA:

```bash
# .env
TLS_EMAIL=admin@example.com
SOCKET_PROXY_HOST=your-real-domain.com
```

When `TLS_EMAIL` is set, Caddy uses ACME to obtain real certificates.

## Configuration Reference

| Variable | Description |
| --- | --- |
| `SOCKET_PROXY_HOST` | Hostname for the proxy |
| `SOCKET_IO_PROXY_URL` | Full HTTPS URL for tests |
| `VITE_SOCKET_PROXY_URL` | URL for the example app |
| `ANDROID_PROXY_LAN_IP` | LAN IP for Android host mapping |

## FAQ

**Why not bundle a hosted test server?**

A shared endpoint encourages developers to skip TLS setup, which hides the very problem this
plugin solves. Running your own proxy ensures both mobile platforms talk to a server that
mirrors production constraints.

**Can I automate this in CI?**

Yes. The Docker stack can run in CI. Export `SOCKET_IO_PROXY_URL=https://socket-proxy.local`.

**Do I have to use Caddy?**

Any HTTPS reverse proxy works. The Docker stack uses Caddy for its automatic certificate
generation, but you can substitute Nginx, Traefik, or others.
