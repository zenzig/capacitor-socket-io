## Created with Capacitor Create App

This app was created using [`@capacitor/create-app`](https://github.com/ionic-team/create-capacitor-app),
and comes with a very minimal shell for building an app.

### Running this example

The example consumes the plugin from the parent directory (`"@zenzig/capacitor-socket-io": "file:.."`).
Install the plugin's dependencies and build its `dist/` output from the repository root first—`npm install`
at the top level will trigger the plugin's `prepare` script automatically. Then change into the example
workspace and install its own dependencies. All commands in the following sections assume you remain inside
`example-app/`:

```bash
# from the repository root
npm install

cd example-app
npm install
npm run build
```

Then sync the native projects so they pick up the latest `@zenzig/capacitor-socket-io` build:

```bash
npx cap sync ios android
```

Visit `https://socket-proxy.local/` (served by the Docker proxy stack) to open the matching web console. It shares
the same Socket.IO session as the native app so you can observe broadcasts, presence updates, and ping/pong traffic
across all three clients.

> **Note:** The playground defaults to `https://socket-proxy.local/`. Replace it with your own
> HTTPS proxy hostname by setting `VITE_SOCKET_PROXY_URL=https://socket-proxy.local` (or your
> equivalent) in the root `.env` file. Running `npm run proxy:setup` **from the repository root**
> will generate mkcert certificates, normalise `.env`, and start the bundled Docker proxy
> automatically (requires Docker to be running). Use `--host dev.example.com` to target a different
> hostname, `--port 4443` if port 443 is already in use locally, or `--no-start` to skip launching
> containers. If you are already inside `example-app/`, run `npm run proxy:setup -- --no-start`
> from the repository root in another terminal, or use `npm --prefix .. run proxy:setup -- --no-start`
> to invoke the script without leaving this
> directory. If the
> proxy is reachable on a different LAN IP from the Android emulator, provide the address via
> `ANDROID_PROXY_LAN_IP`. The Android launcher script will add a hosts entry before installing the
> app so the hostname resolves correctly:
>
> ```env
> SOCKET_PROXY_PORT=443
> VITE_SOCKET_PROXY_URL=https://socket-proxy.local
> ANDROID_PROXY_LAN_IP=192.168.0.28
> ```
>
> When using a non-default port, append it to the URLs—for example
> `VITE_SOCKET_PROXY_URL=https://socket-proxy.local:4443`.
>
> Self-signed certificates are only trusted in development builds; production builds must present a
> CA-issued or pinned certificate.

### Accessing a LAN proxy from the Android emulator

If your proxy is bound to a private IP (such as `192.168.0.28`) behind the hostname
`socket-proxy.local`, add a hosts entry inside the emulator so that the domain resolves to the
LAN address. When `ANDROID_PROXY_LAN_IP` is present, `npm run test:android` performs these steps
automatically before deploying the app. To apply the mapping manually:

```bash
adb root
adb remount
adb shell "echo '192.168.0.28 socket-proxy.local' >> /system/etc/hosts"
adb reboot
```

Install the development CA (for example the `mkcert` root) on the emulator afterwards so TLS
handshakes succeed. Similar steps apply to physical devices—consult `docs/testing-with-proxy.md`
for full details.

#### iOS

Run the interactive launcher to pick a simulator (it boots the device and installs the app without opening Xcode):

```bash
npm run test:ios
```

#### Android

Launch an emulator or choose a connected device directly from the prompt:

```bash
npm run test:android
```

> **Emulator requirement:** Use a Google APIs system image (not Google Play Store) so the Android
> SDK allows `/system/etc/hosts` to be remounted read/write. The launcher starts emulators with
> `-writable-system` automatically; if you bring your own running emulator, reboot it with
> `emulator -avd <name> -writable-system` before running the script.

During development you can keep the Vite dev server running for quick web refreshes:

```bash
npm start
```
