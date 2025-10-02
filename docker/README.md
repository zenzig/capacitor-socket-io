# Socket.IO proxy docker setup

This folder contains a two-container stack that mirrors a production deployment:

- `socketio`: a Socket.IO upstream server that echoes events.
- `proxy`: an Nginx TLS reverse proxy that terminates HTTPS and forwards traffic to `socketio`.

## Usage

1. Generate a trusted certificate for `socket-proxy.local` (see `docs/testing-with-proxy.md`).
2. Copy the certificate files into `docker/certs/` as `socket-proxy.pem` (certificate chain) and
   `socket-proxy-key.pem` (private key). The directory is ignored by git so you can safely store
   local certs here.
3. Ensure the hostname resolves to your machine (for example add `127.0.0.1 socket-proxy.local` to
   `/etc/hosts`).
4. From the repository root, run:

   ```bash
   npm run proxy:up
   ```

   This builds the upstream server image, starts both containers, and exposes HTTPS on port 443.

5. Export or record `SOCKET_IO_PROXY_URL=https://socket-proxy.local` (the default in `.env.example`).
6. When you are done, stop the stack with:

   ```bash
   npm run proxy:down
   ```

Use `npm run proxy:logs` to follow Nginx output while debugging.
