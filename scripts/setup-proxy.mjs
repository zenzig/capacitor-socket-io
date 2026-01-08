import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { computeHostsUpdate, extractHostIps } from './lib/hosts-utils.mjs';
import { extractCaFromVolume, waitForProxy, installCaOnMacOS } from './export-caddy-ca.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const envExamplePath = path.join(repoRoot, '.env.example');
const envPath = path.join(repoRoot, '.env');
const certDir = path.join(repoRoot, 'docker', 'certs');
const caCertPath = path.join(certDir, 'caddy-root.crt');
const rawArgs = process.argv.slice(2);
const options = parseArgs(rawArgs);
const { noStart, host: hostOverride, port: portOverride, writeHosts, resetCa } = options;

function logStep(message) {
  console.log(`\n▶ ${message}`);
}

function parseArgs(args) {
  const result = { noStart: false, host: undefined, port: undefined, writeHosts: false, resetCa: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--no-start') {
      result.noStart = true;
      continue;
    }

    if (arg === '--write-hosts') {
      result.writeHosts = true;
      continue;
    }

    if (arg === '--reset-ca') {
      result.resetCa = true;
      continue;
    }

    if (arg.startsWith('--host=')) {
      const value = arg.slice('--host='.length).trim();
      if (value) {
        result.host = value;
      } else {
        console.warn('Ignoring empty --host value.');
      }
      continue;
    }

    if (arg === '--host') {
      const next = args[index + 1];
      if (next && !next.startsWith('--')) {
        result.host = next.trim();
        index += 1;
      } else {
        console.warn('Ignoring --host flag without a value.');
      }
      continue;
    }

    if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length).trim();
      if (value) {
        result.port = value;
      } else {
        console.warn('Ignoring empty --port value.');
      }
      continue;
    }

    if (arg === '--port') {
      const next = args[index + 1];
      if (next && !next.startsWith('--')) {
        result.port = next.trim();
        index += 1;
      } else {
        console.warn('Ignoring --port flag without a value.');
      }
      continue;
    }

    console.warn(`Unknown option "${arg}" ignored.`);
  }

  return result;
}

function normalisePort(value) {
  if (value === undefined) {
    return undefined;
  }

  const portNumber = Number.parseInt(String(value), 10);
  if (!Number.isFinite(portNumber) || portNumber <= 0 || portNumber > 65535) {
    throw new Error(`Invalid port "${value}". Choose an integer between 1 and 65535.`);
  }

  return portNumber;
}

function checkPortAvailability(port) {
  if (port === undefined) {
    return;
  }

  if (process.platform !== 'win32') {
    const args = ['-nP', '-iTCP', `:${port}`, '-sTCP:LISTEN'];
    const result = spawnSync('lsof', args, { stdio: 'pipe' });

    if (result.error && result.error.code === 'ENOENT') {
      console.warn('lsof not found; skipping port availability check.');
    } else if (result.status === 0) {
      const listeners = parseLsofListeners(result.stdout?.toString() ?? '');
      if (listeners.length > 0) {
        const formatted = listeners.map((entry) => `  • ${entry}`).join('\n');
        throw new Error(`Port ${port} appears to be in use by:\n${formatted}\n\nClose the process or rerun with --port <alternate>.`);
      }
    } else if (result.status === 1) {
      // No listeners found; lsof returns exit code 1 in this case.
    } else if (result.stderr) {
      console.warn(`lsof reported an unexpected error while checking port ${port}: ${result.stderr.toString().trim()}`);
    }
  }

  if (port < 1024 && typeof process.getuid === 'function' && process.getuid() !== 0) {
    console.warn(`Port ${port} is privileged. Docker will require elevated permissions on some systems; consider choosing a port >=1024 via --port.`);
  }
}

function parseLsofListeners(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return [];
  }

  const summaries = [];

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const tokens = line.split(/\s+/);
    if (tokens.length < 9) {
      summaries.push(line);
      continue;
    }

    const [command, pid, user, fd, type, device, sizeOff, node, name, ...rest] = tokens;
    const address = [name, ...rest].join(' ').replace('(LISTEN)', '').trim();
    const descriptor = `${command} (pid ${pid}, user ${user}) listening on ${address || name}`;
    summaries.push(descriptor);
  }

  return summaries;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? 'inherit',
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const joined = [command, ...args].join(' ');
    throw new Error(`${joined} exited with code ${result.status}`);
  }

  return result;
}

function ensureEnvFile() {
  if (!existsSync(envPath)) {
    if (!existsSync(envExamplePath)) {
      throw new Error('Missing .env.example – cannot bootstrap .env');
    }

    copyFileSync(envExamplePath, envPath);
    console.log('Created .env from .env.example');
  }
}

function upsertEnvValue(key, value) {
  const original = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const lines = original.split(/\r?\n/);
  const keyPattern = new RegExp(`^${key}=`);
  let updated = false;

  const next = lines.map((line) => {
    if (keyPattern.test(line)) {
      updated = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!updated) {
    next.push(`${key}=${value}`);
  }

  const normalised = next.filter((line, index, arr) => !(index === arr.length - 1 && line.trim() === '' && arr[index - 1]?.trim() === '')).join('\n');
  writeFileSync(envPath, normalised.endsWith('\n') ? normalised : `${normalised}\n`, 'utf8');
}

function isIpAddress(value) {
  if (!value) {
    return false;
  }

  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function detectLanIp() {
  const interfaces = os.networkInterfaces?.();
  if (!interfaces) {
    return undefined;
  }

  const candidates = [];
  for (const value of Object.values(interfaces)) {
    if (!Array.isArray(value)) {
      continue;
    }

    for (const details of value) {
      if (details && details.family === 'IPv4' && details.address && !details.internal) {
        candidates.push(details.address);
      }
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const sortScore = (address) => {
    if (/^192\.168\./.test(address)) {
      return 3;
    }
    if (/^10\./.test(address)) {
      return 2;
    }
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) {
      return 1;
    }
    return 0;
  };

  candidates.sort((a, b) => sortScore(b) - sortScore(a));
  return candidates[0];
}

function resolveHostsFile() {
  const override = process.env.SOCKET_PROXY_HOSTS_PATH?.trim();
  if (override) {
    return override;
  }

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:/Windows';
    return path.join(systemRoot, 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

function checkHostsEntry(host, { writeHosts = false } = {}) {
  const hostsFile = resolveHostsFile();

  try {
    if (!existsSync(hostsFile)) {
      console.warn(`Unable to locate hosts file at ${hostsFile}. Please add an entry mapping ${host} manually.`);
      return;
    }

    const content = readFileSync(hostsFile, 'utf8');
    const existingIps = extractHostIps(content, host);
    const envLanIp = process.env.ANDROID_PROXY_LAN_IP?.trim();
    const detectedLanIp = detectLanIp();
    const suggestedIp = envLanIp || detectedLanIp || '127.0.0.1';

    if (writeHosts && suggestedIp !== '127.0.0.1') {
      if (process.platform === 'win32') {
        console.warn(`Automatic hosts editing is not supported on Windows. Run an elevated editor and add '${suggestedIp} ${host}' manually.`);
        return;
      }

      const result = ensureHostsEntryWritten({ host, ip: suggestedIp, hostsFile, initialContent: content });

      if (!result.success) {
        console.warn(`Unable to update ${hostsFile} automatically. Please add '${suggestedIp} ${host}' manually.`);
        return;
      }

      if (result.changed) {
        const previousIps = result.previousIps.filter((ip) => ip && ip !== suggestedIp);
        if (previousIps.length > 0) {
          console.log(`Updated hosts entry for ${host}: replaced ${previousIps.join(', ')} with ${suggestedIp}.`);
        } else if (result.previousIps.length > 1) {
          console.log(`Condensed multiple hosts entries for ${host} to '${suggestedIp} ${host}'.`);
        } else if (result.previousIps.length === 0) {
          console.log(`Added hosts entry '${suggestedIp} ${host}'.`);
        } else {
          console.log(`Refreshed hosts entry for ${host}.`);
        }
      } else {
        console.log(`Hosts entry for ${host} already points to ${suggestedIp}.`);
      }
      return;
    }

    if (existingIps.length === 0) {
      const lanMessage = suggestedIp === '127.0.0.1'
        ? 'Replace 127.0.0.1 with your machine’s LAN IP so Android and iOS devices can resolve it.'
        : 'Update the IP if your LAN differs.';
      console.warn(`Map ${host} in ${hostsFile} to your machine's LAN IP. Suggested entry: '${suggestedIp} ${host}'. ${lanMessage}`);
      return;
    }

    if (existingIps.length > 1) {
      console.warn(`Multiple IPs found for ${host} (${existingIps.join(', ')}). Remove stale entries so only the active mapping remains.`);
      return;
    }

    const currentIp = existingIps[0];
    if (suggestedIp !== '127.0.0.1' && currentIp !== suggestedIp) {
      console.warn(`Hosts entry for ${host} currently points to ${currentIp}. Update it to ${suggestedIp} or rerun with --write-hosts.`);
      return;
    }

    console.log(`Hosts entry for ${host} already present.`);
  } catch (error) {
    console.warn(`Unable to read ${hostsFile}: ${error.message}`);
  }
}

function ensureHostsEntryWritten({ host, ip, hostsFile, initialContent }) {
  try {
    const content = initialContent ?? readFileSync(hostsFile, 'utf8');
    const { content: updatedContent, changed, previousIps } = computeHostsUpdate({ originalContent: content, host, ip });
    const priorIps = [...previousIps];

    if (!changed) {
      return { changed: false, success: true, previousIps: priorIps };
    }

    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      writeFileSync(hostsFile, updatedContent, 'utf8');
      return { changed: true, success: true, previousIps: priorIps };
    }

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'socket-proxy-hosts-'));
    const tempFile = path.join(tempDir, 'hosts');
    writeFileSync(tempFile, updatedContent, 'utf8');

    const result = spawnSync('sudo', ['cp', tempFile, hostsFile], { stdio: 'inherit' });
    if (result.error) {
      console.warn(`sudo cp failed: ${result.error.message}`);
    }
    const success = !result.error && result.status === 0;

    try {
      unlinkSync(tempFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`Unable to delete temp hosts file: ${error.message}`);
      }
    }

    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`Unable to remove temp directory: ${error.message}`);
      }
    }

    return { changed: true, success, previousIps: priorIps };
  } catch (error) {
    console.warn(`Failed to update hosts file automatically: ${error.message}`);
    return { changed: false, success: false, previousIps: [] };
  }
}

function resetCaddyCa() {
  logStep('Resetting Caddy CA (removing data volume)');
  const result = spawnSync('docker', ['volume', 'rm', '-f', 'capacitor-socket-io_caddy_data'], { stdio: 'pipe' });
  if (result.status === 0) {
    console.log('Caddy data volume removed. A new CA will be generated on next startup.');
  } else {
    const stderr = result.stderr?.toString().trim();
    if (stderr?.includes('No such volume')) {
      console.log('No existing Caddy data volume found.');
    } else {
      console.warn('Could not remove volume:', stderr || 'unknown error');
    }
  }
}

function assertDockerDaemon() {
  const result = spawnSync('docker', ['info'], { stdio: 'pipe' });

  if (result.error) {
    throw new Error('Docker CLI not found. Install Docker Desktop (macOS/Windows) or ensure the "docker" binary is available.');
  }

  if (result.status !== 0) {
    const fragments = [];
    if (result.stderr) {
      const text = result.stderr.toString().trim();
      if (text) {
        fragments.push(text);
      }
    }
    if (result.stdout) {
      const text = result.stdout.toString().trim();
      if (text) {
        fragments.push(text);
      }
    }

    const details = fragments.join('\n');
    const hint = 'Docker daemon is not reachable. Start Docker Desktop or your container runtime, then rerun this script.';
    throw new Error(details ? `${hint}\n\nDetails: ${details}` : hint);
  }
}

function startProxyStack({ port }) {
  logStep(`Starting Docker proxy stack (detached on port ${port})`);
  run('npm', ['run', 'proxy:up:ci'], {
    env: {
      ...process.env,
      SOCKET_PROXY_PORT: String(port),
    },
  });
}

async function main() {
  logStep('Preparing environment');
  ensureEnvFile();
  loadEnv({ path: envPath });

  const envHost = process.env.SOCKET_PROXY_HOST?.trim();
  let host = envHost && envHost.length > 0 ? envHost : 'socket-proxy.local';

  if (hostOverride && hostOverride.length > 0) {
    host = hostOverride;
    console.log(`Using host override: ${hostOverride}`);
  }

  host = host.trim() || 'socket-proxy.local';

  const defaultPort = 443;
  let port = normalisePort(portOverride ?? process.env.SOCKET_PROXY_PORT?.trim());
  if (port === undefined) {
    port = defaultPort;
  }

  const proxyUrl = `https://${host}${port === 443 ? '' : `:${port}`}`;

  logStep(`Normalising .env for host ${host}`);
  upsertEnvValue('SOCKET_PROXY_HOST', host);
  upsertEnvValue('SOCKET_PROXY_PORT', String(port));
  upsertEnvValue('SOCKET_IO_PROXY_URL', proxyUrl);
  upsertEnvValue('VITE_SOCKET_PROXY_URL', proxyUrl);

  process.env.SOCKET_PROXY_HOST = host;
  process.env.SOCKET_PROXY_PORT = String(port);
  process.env.SOCKET_IO_PROXY_URL = proxyUrl;
  process.env.VITE_SOCKET_PROXY_URL = proxyUrl;

  const existingLanIp = process.env.ANDROID_PROXY_LAN_IP?.trim();
  const detectedLanIp = !isIpAddress(host) ? detectLanIp() : undefined;
  let lanIpForClients = existingLanIp;

  if (detectedLanIp) {
    if (existingLanIp !== detectedLanIp) {
      upsertEnvValue('ANDROID_PROXY_LAN_IP', detectedLanIp);
      console.log(`Detected LAN IP ${detectedLanIp} and recorded it in .env (ANDROID_PROXY_LAN_IP).`);
    }
    process.env.ANDROID_PROXY_LAN_IP = detectedLanIp;
    lanIpForClients = detectedLanIp;
  } else if (!existingLanIp && !isIpAddress(host)) {
    console.warn('Unable to detect a LAN IP automatically. Set ANDROID_PROXY_LAN_IP in .env if your emulator needs a host mapping.');
  }

  const preferredDevServerHost = (() => {
    if (lanIpForClients && lanIpForClients.length > 0) {
      return lanIpForClients;
    }
    if (isIpAddress(host)) {
      return host;
    }
    return '127.0.0.1';
  })();

  upsertEnvValue('E2E_DEV_SERVER_HOST', preferredDevServerHost);
  process.env.E2E_DEV_SERVER_HOST = preferredDevServerHost;
  if (preferredDevServerHost === '127.0.0.1') {
    console.log('No LAN IP detected; defaulting E2E_DEV_SERVER_HOST to 127.0.0.1.');
  } else {
    console.log(`Updated E2E_DEV_SERVER_HOST to ${preferredDevServerHost}.`);
  }

  // Reset Caddy CA if requested (useful if CA expired or needs regeneration)
  if (resetCa) {
    resetCaddyCa();
  }

  logStep('Checking hosts file');
  checkHostsEntry(host, { writeHosts });

  if (!noStart) {
    logStep(`Checking port availability for ${port}`);
    checkPortAvailability(port);
    logStep('Verifying Docker daemon');
    assertDockerDaemon();
    startProxyStack({ port });
    console.log(`\n✅ Proxy ready at ${proxyUrl}`);

    // Export Caddy's root CA for device trust
    logStep('Exporting Caddy root CA certificate');
    await exportCaddyCa();
  } else {
    console.log(`\n⚠️  Skipping Docker startup (--no-start). Run "npm run proxy:up" when you're ready to launch the stack (target port ${port}).`);
  }

  console.log('\nNext steps:');
  if (noStart) {
    console.log('  • Start the proxy manually with "npm run proxy:up" (or rerun without --no-start).');
    console.log('  • After it is running, use "npm run proxy:logs" to monitor Caddy.');
  } else {
    console.log('  • Run "npm run proxy:logs" in another terminal to monitor Caddy.');
  }
  console.log('  • Install docker/certs/caddy-root.crt on your Android emulator/iOS simulator.');
  console.log('  • From example-app/, run "npm install" (first time) then "npm run test:android" or "npm run test:ios".');
}

async function exportCaddyCa() {
  // Wait for proxy to be ready and trigger CA generation
  await waitForProxy();
  
  // Extract the CA certificate
  const success = await extractCaFromVolume();
  if (success) {
    console.log('  ✔ Root CA exported to docker/certs/caddy-root.crt');
    
    // Auto-install on macOS
    if (process.platform === 'darwin') {
      logStep('Installing CA certificate on macOS');
      await installCaOnMacOS(caCertPath);
    }
  } else {
    console.warn('  ⚠️  Could not export CA. Run "npm run proxy:export-ca" after making an HTTPS request.');
  }
}

const isCliExecution = (() => {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  const current = fileURLToPath(import.meta.url);
  return invoked === current;
})();

if (isCliExecution) {
  main().catch((error) => {
    console.error(`\n❌ Setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

export { checkHostsEntry, ensureHostsEntryWritten, resolveHostsFile };
