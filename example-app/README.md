## Created with Capacitor Create App

This app was created using [`@capacitor/create-app`](https://github.com/ionic-team/create-capacitor-app),
and comes with a very minimal shell for building an app.

### Running this example

Install dependencies and build the web assets first:

```bash
npm install
npm run build
```

Then sync the native projects so they pick up the latest `@zenzig/capacitor-socket-io` build:

```bash
npx cap sync ios android
```

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

During development you can keep the Vite dev server running for quick web refreshes:

```bash
npm start
```
