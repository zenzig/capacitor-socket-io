#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const androidDir = path.join(repoRoot, 'android');

const ENV_LOCATIONS = [
  path.join(repoRoot, '.env.local'),
  path.join(repoRoot, '.env'),
  path.join(repoRoot, 'example-app', '.env.local'),
  path.join(repoRoot, 'example-app', '.env'),
];

for (const candidate of ENV_LOCATIONS) {
  const result = loadEnv({ path: candidate, override: false });
  if (result.error && result.error.code !== 'ENOENT') {
    console.warn(`[run-e2e-suite] Unable to read environment file at ${candidate}:`, result.error.message ?? result.error);
  }
}

const proxyUrl = process.env.SOCKET_IO_PROXY_URL ?? 'https://socket-proxy.local';
if (!proxyUrl.startsWith('https://')) {
  console.warn('[run-e2e-suite] SOCKET_IO_PROXY_URL does not appear to be HTTPS. Self-signed development certs require TLS.');
}

const { destination: iosDestination, note: iosDestinationNote } = resolveIOSDestination();
if (iosDestinationNote) {
  console.log(`[run-e2e-suite] Using iOS destination: ${iosDestinationNote}`);
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const gradleCommand = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

const steps = [
  {
    name: 'Android Socket.IO bridge test',
    command: gradleCommand,
    args: ['testDebugUnitTest'],
    cwd: androidDir,
    condition: () => true,
  },
  {
    name: 'iOS Socket.IO bridge test',
    command: 'xcodebuild',
    args: ['test', '-scheme', 'ZenzigCapacitorSocketIo', '-destination', iosDestination],
    cwd: repoRoot,
    condition: () => process.platform === 'darwin',
    skipMessage: 'Skipping iOS tests because this host is not macOS.',
  },
  {
    name: 'Web Playwright E2E suite',
    command: npmCommand,
    args: ['run', '--silent', 'test:e2e:web'],
    cwd: repoRoot,
    condition: () => true,
  },
];

function resolveIOSDestination() {
  const fallbackDestination = 'platform=iOS Simulator,name=iPhone 15,OS=latest';
  const envOverride = process.env.E2E_IOS_DESTINATION?.trim();

  if (process.platform !== 'darwin') {
    return { destination: envOverride ?? fallbackDestination };
  }

  if (envOverride) {
    return { destination: envOverride, note: `env override (${envOverride})` };
  }

  const result = spawnSync('xcrun', ['simctl', 'list', '--json', 'devices'], { encoding: 'utf8' });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    console.warn(
      `[run-e2e-suite] Unable to query available simulators (exit ${result.status}${stderr ? `: ${stderr}` : ''}) – falling back to default destination.`,
    );
    return { destination: fallbackDestination };
  }

  try {
    const data = JSON.parse(result.stdout ?? '{}');
    const devices = Object.entries(data.devices ?? {})
      .filter(([runtime]) => typeof runtime === 'string' && runtime.includes('iOS'))
      .flatMap(([runtime, entries]) =>
        (entries ?? []).map((device) => ({ ...device, runtime })),
      )
      .filter((device) => device?.isAvailable);

    if (devices.length === 0) {
      console.warn('[run-e2e-suite] No available iOS simulators found via simctl; using default destination.');
      return { destination: fallbackDestination };
    }

    const booted = devices.find((device) => device.state === 'Booted');
    const candidate = booted ?? devices[0];
    const destination = `platform=iOS Simulator,id=${candidate.udid}`;
    const runtimeLabel = candidate.runtime?.split('.').pop()?.replace(/-/g, ' ') ?? 'unknown runtime';
    return {
      destination,
      note: `auto-selected ${candidate.name} (${runtimeLabel})`,
    };
  } catch (error) {
    console.warn('[run-e2e-suite] Failed to parse simctl JSON output – using default destination.', error?.message ?? error);
    return { destination: fallbackDestination };
  }
}

async function run() {
  for (const step of steps) {
    if (typeof step.condition === 'function' && !step.condition()) {
      if (step.skipMessage) {
        console.warn(`[run-e2e-suite] ${step.skipMessage}`);
      }
      continue;
    }

    console.log(`\n[run-e2e-suite] ➤ ${step.name}`);
    await runCommand(step.command, step.args, { cwd: step.cwd, env: process.env });
  }

  console.log('\n[run-e2e-suite] ✅ All E2E checks completed successfully');
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      shell: false,
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

run().catch((error) => {
  console.error('\n[run-e2e-suite] ❌ E2E suite failed:', error?.message ?? error);
  process.exitCode = 1;
});
