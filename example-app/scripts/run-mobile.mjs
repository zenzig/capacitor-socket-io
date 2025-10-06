import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { computeHostsUpdate } from '../../scripts/lib/hosts-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');

// Load environment variables from the example app directory and repository root without overriding existing values.
const ENV_LOCATIONS = [
  path.resolve(__dirname, '..', '.env.local'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env.local'),
  path.resolve(__dirname, '..', '..', '.env'),
];

for (const candidate of ENV_LOCATIONS) {
  const result = loadEnv({ path: candidate, override: false });
  if (result.error && result.error.code !== 'ENOENT') {
    console.warn(`Unable to read environment file at ${candidate}:`, result.error.message ?? result.error);
  }
}

const useShell = process.platform === 'win32';
let proxyHost;
let proxyLanIp;
let rl;

async function main() {
  ({ proxyHost, proxyLanIp } = resolveProxyConfig());

  const platform = process.argv[2];
  if (!['android', 'ios'].includes(platform)) {
    console.error('Usage: node ./scripts/run-mobile.mjs <android|ios>');
    process.exit(1);
  }

  rl = createInterface({ input, output });

  try {
    if (platform === 'android') {
      await runAndroid();
    } else {
      await runIOS();
    }
  } catch (error) {
    console.error(`\n${platform} run failed:`, error?.message ?? error);
    process.exitCode = 1;
  } finally {
    rl?.close();
  }
}

async function runAndroid() {
  const avdList = readAvdList();
  const deviceList = listAndroidDevices();

  if (avdList.length === 0 && deviceList.length === 0) {
    throw new Error('No Android emulators or devices detected. Install an AVD in Android Studio or attach a device.');
  }

  const options = [];
  for (const device of deviceList) {
    options.push({
      label: `Use connected device: ${device.id} (${device.description})`,
      run: () => configureAndRunAndroid(device.id),
    });
  }

  for (const avd of avdList) {
    options.push({
      label: `Launch emulator: ${avd}`,
      run: () => launchAvdAndRun(avd, deviceList.map((d) => d.id)),
    });
  }

  const choice = await promptForChoice('Select an Android target', options.map((o) => o.label));
  await options[choice].run();
}

function readAvdList() {
  const result = spawnSync('emulator', ['-list-avds'], { encoding: 'utf8' });
  if (result.error) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listAndroidDevices() {
  const result = spawnSync('adb', ['devices', '-l'], { encoding: 'utf8' });
  if (result.error) {
    return [];
  }

  const lines = result.stdout.split(/\r?\n/).slice(1); // skip header
  const devices = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, state, ...rest] = trimmed.split(/\s+/);
    if (!id || !state || state === 'offline') continue;
    devices.push({ id, state, description: rest.join(' ') || state });
  }
  return devices;
}

async function launchAvdAndRun(avdName, existingIds) {
  console.log(`\nStarting emulator ${avdName} with writable system image…`);
  const emulatorProc = spawn('emulator', ['-avd', avdName, '-writable-system'], {
    stdio: 'ignore',
    detached: true,
  });
  emulatorProc.unref();

  const targetId = await waitForAndroidDevice(existingIds);
  console.log(`Detected emulator ${targetId}. Configuring proxy mapping…`);
  await configureAndroidHosts(targetId);
  console.log('Installing app…\n');
  await runCapacitor(['cap', 'run', 'android', '--target', targetId]);
}

async function waitForAndroidDevice(existingIds) {
  const timeoutMs = 180_000;
  const start = Date.now();
  const previous = new Set(existingIds);

  while (Date.now() - start < timeoutMs) {
    await delay(2000);
    const devices = listAndroidDevices();
    const ready = devices.find((d) => !previous.has(d.id) && d.state === 'device');
    if (ready) {
      return ready.id;
    }
  }

  throw new Error('Timed out waiting for the Android emulator to boot.');
}

async function runIOS() {
  const simulators = listIOSSimulators();
  if (simulators.length === 0) {
    throw new Error('No available iOS simulators detected. Install one via Xcode > Settings > Platforms.');
  }

  const labels = simulators.map((sim) => `${sim.name} (${sim.runtime})${sim.state === 'Booted' ? ' [booted]' : ''}`);
  const choice = await promptForChoice('Select an iOS simulator', labels);
  const simulator = simulators[choice];

  await ensureSimulatorBooted(simulator);
  console.log(`\nInstalling app on ${simulator.name}…\n`);
  await runCapacitor(['cap', 'run', 'ios', '--target', simulator.udid, '--scheme', 'App']);
}

function listIOSSimulators() {
  const result = spawnSync('xcrun', ['simctl', 'list', '--json', 'devices'], { encoding: 'utf8' });
  if (result.error) {
    return [];
  }

  const data = JSON.parse(result.stdout);
  const devices = [];
  for (const [runtime, runtimeDevices] of Object.entries(data.devices ?? {})) {
    for (const device of runtimeDevices) {
      if (!device.isAvailable) continue;
      devices.push({
        name: device.name,
        udid: device.udid,
        runtime,
        state: device.state,
      });
    }
  }

  devices.sort((a, b) => {
    if (a.state === 'Booted' && b.state !== 'Booted') return -1;
    if (a.state !== 'Booted' && b.state === 'Booted') return 1;
    return a.name.localeCompare(b.name);
  });

  return devices;
}

async function ensureSimulatorBooted(simulator) {
  if (simulator.state !== 'Booted') {
    console.log(`\nBooting ${simulator.name}…`);
    spawnSync('xcrun', ['simctl', 'boot', simulator.udid], { stdio: 'ignore' });
    spawnSync('xcrun', ['simctl', 'bootstatus', simulator.udid, '-b'], { stdio: 'inherit' });
  }

  spawnSync('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', simulator.udid]);
}

async function promptForChoice(message, options) {
  output.write(`\n${message}:\n`);
  options.forEach((label, index) => {
    output.write(`  [${index + 1}] ${label}\n`);
  });

  while (true) {
    const answer = await rl.question('Enter choice number: ');
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isNaN(index) && index >= 0 && index < options.length) {
      return index;
    }
    console.log('Please enter a valid option number.');
  }
}

function runCapacitor(args) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const proc = spawn(command, args, {
      cwd: appRoot,
      stdio: 'inherit',
      shell: useShell,
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npx ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}


async function configureAndroidHosts(targetId) {
  if (!proxyHost || !proxyLanIp || proxyHost === proxyLanIp) {
    return;
  }

  console.log(`  → Ensuring ${proxyHost} resolves to ${proxyLanIp} on device ${targetId ?? '<default>'}`);

  const adbArgs = (...args) => (targetId ? ['-s', targetId, ...args] : args);

  const runAdb = (args) => {
    const result = spawnSync('adb', adbArgs(...args), { encoding: 'utf8' });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim();
      throw new Error(`adb ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
    }
    return result.stdout;
  };

  try {
    runAdb(['root']);
    await delay(750);
    try {
      runAdb(['remount']);
    } catch (error) {
      throw new Error(
        `adb remount failed. Ensure the emulator was started with -writable-system and uses a Google APIs system image (not Google Play Store). Original error: ${
          error?.message ?? error
        }`,
      );
    }
    const originalHosts = runAdb(['shell', 'cat', '/system/etc/hosts']);
    const { content: updatedHosts, changed } = computeHostsUpdate({
      originalContent: originalHosts,
      host: proxyHost,
      ip: proxyLanIp,
    });

    if (!changed) {
      console.log('  ✔ Host mapping already up to date');
      return;
    }

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cap-socket-io-hosts-'));
    const tempFile = path.join(tempDir, 'hosts');
    try {
      writeFileSync(tempFile, updatedHosts, 'utf8');
      runAdb(['push', tempFile, '/system/etc/hosts']);
      runAdb(['shell', 'chmod', '644', '/system/etc/hosts']);
      console.log('  ✔ Host mapping updated');
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn('  ⚠️  Unable to remove temporary directory:', cleanupError?.message ?? cleanupError);
      }
    }
  } catch (error) {
    console.warn('  ⚠️  Unable to update /system/etc/hosts automatically. Proceeding anyway.', error?.message ?? error);
  }
}

function resolveProxyConfig() {
  const canonicalUrl = process.env.VITE_SOCKET_PROXY_URL;
  const androidUrlOverride = process.env.VITE_SOCKET_PROXY_URL_ANDROID;
  const lanIpOverride =
    process.env.ANDROID_PROXY_LAN_IP || process.env.VITE_SOCKET_PROXY_URL_ANDROID_LAN_IP || undefined;

  const host = safeHostname(canonicalUrl) || safeHostname(androidUrlOverride);
  const lanIp = lanIpOverride || extractLanIp(androidUrlOverride);

  return { proxyHost: host, proxyLanIp: lanIp };
}

function safeHostname(url) {
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).hostname;
  } catch (error) {
    return undefined;
  }
}

function extractLanIp(url) {
  const host = safeHostname(url);
  if (!host) {
    return undefined;
  }

  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ? host : undefined;
}

function setProxyConfigForTests({ host, lanIp }) {
  proxyHost = host;
  proxyLanIp = lanIp;
}

const modulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
const isCliExecution = invokedPath === modulePath;

if (isCliExecution) {
  main().catch((error) => {
    console.error('\nrun-mobile failed:', error?.message ?? error);
    process.exitCode = 1;
  });
}

export { configureAndroidHosts, resolveProxyConfig, setProxyConfigForTests };
