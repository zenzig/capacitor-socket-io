# Socket.IO Proxy Docker Setup

This folder contains a two-container stack that mirrors a production deployment:

- `socketio`: a Socket.IO upstream server that echoes events
- `proxy`: a Caddy TLS reverse proxy that terminates HTTPS and forwards traffic to `socketio`

Caddy uses its built-in internal CA to generate trusted certificates for any domain name (including
made-up ones like `socket-proxy.local`). No external tools like mkcert are required.

## Quick Start

```bash
npm run proxy:setup -- --write-hosts
```

This single command:
1. Creates `.env` from `.env.example` if missing
2. Detects your LAN IP and updates `.env` variables
3. Updates `/etc/hosts` with the LAN IP mapping
4. Starts the Docker stack with Caddy + Socket.IO server
5. Installs Caddy's root CA on macOS for trusted HTTPS

## Setup Options

| Flag | Description |
|------|-------------|
| `--host <hostname>` | Override the proxy hostname (default: `socket-proxy.local`) |
| `--port <port>` | Override the HTTPS port (default: `443`) |
| `--write-hosts` | Auto-update `/etc/hosts` with LAN IP mapping |
| `--no-start` | Configure `.env` only, don't start Docker |
| `--reset-ca` | Remove Caddy's CA volume before starting (regenerates certificates) |

## Proxy Commands

| Command | Description |
|---------|-------------|
| `npm run proxy:up` | Start the proxy stack |
| `npm run proxy:down` | Stop the proxy stack |
| `npm run proxy:logs` | Tail Caddy logs |
| `npm run proxy:setup` | Full setup (configure + start + install CA) |
| `npm run proxy:reset-ca` | Remove CA volume for regeneration |

## Self-Signed Certificate Handling

The example app and plugin include a **debug-only trust-all SSL mode**:

- Enabled by default in the example app via the "Allow Untrusted Certs" checkbox
- **No manual certificate installation required** on emulators or simulators
- In production, only properly signed certificates are accepted

This means you can connect to the proxy from iOS simulators and Android emulators without
dragging certificate files or configuring trust settings.

## Production Mode (Real Certificates)

To use Let's Encrypt/ZeroSSL instead of Caddy's internal CA:

1. Set `TLS_EMAIL` in `.env` to a valid email address
2. Use a real domain name for `SOCKET_PROXY_HOST`
3. Ensure your domain has valid DNS pointing to your server
4. Ports 80 and 443 must be externally accessible

```bash
# .env
TLS_EMAIL=admin@example.com
SOCKET_PROXY_HOST=your-real-domain.com
```

When `TLS_EMAIL` is set, Caddy uses ACME to obtain real certificates.

## JWT Authentication (Optional)

The upstream server can validate JSON Web Tokens before accepting connections. Add these
environment variables to `.env` before running `npm run proxy:up`:

- `SOCKET_SERVER_AUTH_SECRET` - raw signing secret shared with clients, or
- `SOCKET_SERVER_AUTH_PASSPHRASE` plus optional `SOCKET_SERVER_AUTH_SALT` - derives a secret using PBKDF2

Clients must send a JWT in one of three locations:
- `socket.handshake.auth.token`
- A `token` query parameter
- An `Authorization: Bearer <token>` header

Mint a token for local testing:

```bash
SOCKET_SERVER_AUTH_SECRET=dev-secret node --input-type=module <<'NODE'
import jwt from 'jsonwebtoken';

const token = jwt.sign(
   { sub: 'developer', scopes: ['presence'] },
   process.env.SOCKET_SERVER_AUTH_SECRET,
   {
      expiresIn: '15m',
      issuer: 'socket-proxy.local',
      audience: 'socket-proxy-clients',
   },
);

console.log(token);
NODE
```

## Resetting the CA

If you need to regenerate Caddy's CA:

```bash
npm run proxy:reset-ca
npm run proxy:setup
```
