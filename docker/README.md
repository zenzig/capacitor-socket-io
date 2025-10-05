# Socket.IO proxy docker setup

This folder contains a two-container stack that mirrors a production deployment:

- `socketio`: a Socket.IO upstream server that echoes events.
- `proxy`: an Nginx TLS reverse proxy that terminates HTTPS and forwards traffic to `socketio`.

## Usage

> **Shortcut:** Run `npm run proxy:setup` from the repository root to execute the steps below
> automatically. The script checks for mkcert, generates certificates, normalises `.env`, and starts
> the stack detached (Docker must be running). Need a different hostname? Pass
> `--host dev.example.com`. Port 443 already in use? Add `--port 4443` (or another open port). Want
> to skip launching containers on this machine? Append `--no-start`.
> Manual instructions remain available for fine-grained control.

1. Generate a trusted certificate for `socket-proxy.local` (see `docs/testing-with-proxy.md`).
2. Copy the certificate files into `docker/certs/` as `socket-proxy.pem` (certificate chain) and
   `socket-proxy-key.pem` (private key). The directory is ignored by git so you can safely store
   local certs here.
3. Ensure the hostname resolves to your machine by mapping it to your LAN IP (for example add
   `192.168.0.28 socket-proxy.local` to `/etc/hosts`). Run `npm run proxy:setup --write-hosts`
   on macOS/Linux to attempt the change automatically (you’ll be prompted for sudo if required).
4. If port 443 is busy on your machine, set `SOCKET_PROXY_PORT` in the repository `.env` file (for
   example `SOCKET_PROXY_PORT=4443`). From the repository root, run:

   ```bash
   npm run proxy:up
   ```

   This builds the upstream server image, starts both containers, and exposes HTTPS on the port you
   configured (defaults to 443).

5. Export or record `SOCKET_IO_PROXY_URL=https://socket-proxy.local` (append `:<port>` if you chose a
   non-default port) — the script writes this automatically when you use `npm run proxy:setup`.
6. When you are done, stop the stack with:

   ```bash
   npm run proxy:down
   ```

Use `npm run proxy:logs` to follow Nginx output while debugging.
