# Socket.IO proxy docker setup

This folder contains a two-container stack that mirrors a production deployment:

- `socketio`: a Socket.IO upstream server that echoes events.
- `proxy`: an Nginx TLS reverse proxy that terminates HTTPS and forwards traffic to `socketio`.

## Usage

> **Shortcut:** Run `npm run proxy:setup` from the repository root to execute the steps below
> automatically. The script checks for mkcert, generates certificates, normalises `.env`, and starts
> the stack detached (Docker must be running). Need a different hostname? Pass
> `--host dev.example.com`. Want to skip launching containers on this machine? Append `--no-start`.
> The proxy binds to port 443; if the script reports that the port is busy, stop the conflicting
> service before restarting setup. The script also rewrites `E2E_DEV_SERVER_HOST` in `.env` so
> Playwright-based flows bind to the same interface.
> Manual instructions remain available for fine-grained control.

1. Generate a trusted certificate for `socket-proxy.local` (see `docs/testing-with-proxy.md`).
2. Copy the certificate files into `docker/certs/` as `socket-proxy.pem` (certificate chain) and
   `socket-proxy-key.pem` (private key). The directory is ignored by git so you can safely store
   local certs here.
3. Ensure the hostname resolves to your machine by mapping it to your LAN IP (for example add
   `192.168.0.28 socket-proxy.local` to `/etc/hosts`). Run `npm run proxy:setup --write-hosts`
   on macOS/Linux to attempt the change automatically (you’ll be prompted for sudo if required).
4. From the repository root, run:

   ```bash
   npm run proxy:up
   ```

   This builds the upstream server image, starts both containers, and exposes HTTPS on port 443.

5. Export or record `SOCKET_IO_PROXY_URL=https://socket-proxy.local` — the script writes this
   automatically when you use `npm run proxy:setup`. Set
   `SOCKET_SERVER_AUTH_SECRET` (or the passphrase variant described below) if you want the upstream
   server to require JWTs during the Socket.IO handshake.
6. When you are done, stop the stack with:

   ```bash
   npm run proxy:down
   ```

Use `npm run proxy:logs` to follow Nginx output while debugging, or verify the stack is healthy with
`curl -sk https://socket-proxy.local/healthz`.

## Enforcing JWT authentication

The upstream server can validate JSON Web Tokens before accepting connections. Add the following
environment variables to `.env` (or export them manually) before running `npm run proxy:up`:

- `SOCKET_SERVER_AUTH_SECRET` – raw signing secret shared with clients, or
- `SOCKET_SERVER_AUTH_PASSPHRASE` plus optional `SOCKET_SERVER_AUTH_SALT` – derives a secret using
   PBKDF2 via `pbkdf2-password-hash`.
- Optional: `SOCKET_SERVER_AUTH_ISSUER`, `SOCKET_SERVER_AUTH_AUDIENCE`,
   `SOCKET_SERVER_AUTH_CLOCK_TOLERANCE` (seconds) to tighten claim validation.

Clients must send a JWT in one of three locations: `socket.handshake.auth.token`, a `token` query
parameter, or an `Authorization: Bearer <token>` header. The decoded claims are exposed to event
handlers as `socket.auth` for additional authorization checks.

To mint a token for local testing, run:

```bash
SOCKET_SERVER_AUTH_SECRET=unit-test-secret node --input-type=module <<'NODE'
import jwt from 'jsonwebtoken';

const secret = process.env.SOCKET_SERVER_AUTH_SECRET;
const token = jwt.sign(
   { sub: 'developer', scopes: ['presence'] },
   secret,
   {
      expiresIn: '15m',
      issuer: process.env.SOCKET_SERVER_AUTH_ISSUER ?? 'socket-proxy.local',
      audience: process.env.SOCKET_SERVER_AUTH_AUDIENCE ?? 'socket-proxy-clients',
   },
);

console.log(token);
NODE
```

Then supply the token via `auth: { token }` when instantiating `socket.io-client` or include it as a
Bearer token header when connecting from custom tooling.
