#!/usr/bin/env node
/**
 * Export Caddy's internal root CA certificate for device trust installation.
 *
 * Caddy generates its internal CA on first HTTPS request. This script:
 * 1. Waits for the proxy to be ready
 * 2. Triggers CA generation by making an HTTPS request (ignoring cert errors)
 * 3. Extracts the root CA from the caddy_data Docker volume
 * 4. Copies it to docker/certs/caddy-root.crt for easy access
 *
 * Usage:
 *   node scripts/export-caddy-ca.mjs [--wait]
 *
 * Options:
 *   --wait    Wait up to 30s for proxy to become available before extracting
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';
import { config as loadEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dockerDir = path.join(repoRoot, 'docker');
const certDir = path.join(dockerDir, 'certs');
const outputPath = path.join(certDir, 'caddy-root.crt');

// Load environment variables from .env
loadEnv({ path: path.join(repoRoot, '.env') });

const VOLUME_NAME = 'capacitor-socket-io_caddy_data';
const CA_PATH_IN_VOLUME = 'caddy/pki/authorities/local/root.crt';

const args = process.argv.slice(2);
const shouldWait = args.includes('--wait');
const shouldInstall = args.includes('--install');

async function main() {
  console.log('▶ Exporting Caddy root CA certificate...\n');

  // Ensure output directory exists
  mkdirSync(certDir, { recursive: true });

  // If --wait flag, wait for proxy and trigger CA generation
  if (shouldWait) {
    await waitForProxy();
  }

  // Try to extract CA from Docker volume
  const extracted = await extractCaFromVolume();

  if (!extracted) {
    console.error('\n❌ Failed to extract Caddy root CA.');
    console.error('   Ensure the proxy is running and has served at least one HTTPS request.');
    console.error('   Try: curl -k https://socket-proxy.local/healthz');
    process.exitCode = 1;
    return;
  }

  console.log(`✅ Caddy root CA exported to: docker/certs/caddy-root.crt`);

  // Auto-install on macOS if requested
  if (shouldInstall && process.platform === 'darwin') {
    await installCaOnMacOS(outputPath);
  }
}

async function installCaOnMacOS(certPath) {
  const targetPath = certPath || outputPath;
  console.log('  Installing CA certificate in macOS System Keychain...');
  
  // Check if already trusted
  const checkResult = spawnSync('security', ['verify-cert', '-c', targetPath], { stdio: 'pipe' });
  if (checkResult.status === 0) {
    console.log('  ✔ CA certificate is already trusted.');
    return true;
  }

  // Install the certificate (requires sudo)
  console.log('  (This may prompt for your password)');
  const installResult = spawnSync('sudo', [
    'security', 'add-trusted-cert',
    '-d', '-r', 'trustRoot',
    '-k', '/Library/Keychains/System.keychain',
    targetPath
  ], { stdio: 'inherit' });

  if (installResult.status === 0) {
    console.log('  ✔ CA certificate installed and trusted on macOS.');
    return true;
  } else {
    console.warn('  ⚠️  Failed to install CA. You may need to run manually:');
    console.warn(`     sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${targetPath}`);
    return false;
  }
}

async function waitForProxy() {
  const proxyHost = process.env.SOCKET_PROXY_HOST || 'socket-proxy.local';
  const proxyPort = parseInt(process.env.SOCKET_PROXY_PORT || '443', 10);
  // Use LAN IP only - 127.0.0.1 won't work for mobile emulators
  const lanIp = process.env.ANDROID_PROXY_LAN_IP;
  
  if (!lanIp) {
    console.error('ANDROID_PROXY_LAN_IP not set in .env - cannot connect to proxy.');
    console.error('Run "npm run proxy:setup" first to detect and set the LAN IP.');
    return;
  }
  
  const maxAttempts = 15;
  const delayMs = 1000;

  console.log(`Waiting for proxy at ${lanIp}:${proxyPort} (hostname: ${proxyHost})...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await makeHttpsRequest(lanIp, proxyPort, '/healthz', proxyHost);
      console.log(`Proxy is ready at ${lanIp}, CA should be generated.\n`);
      return;
    } catch (error) {
      // DEPTH_ZERO_SELF_SIGNED_CERT or similar means the server responded
      // which means the CA was generated - that's actually success for our purposes
      if (error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
          error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
          error.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
          error.message?.includes('self signed')) {
        console.log(`Proxy responded at ${lanIp} (cert untrusted as expected), CA generated.\n`);
        return;
      }
      // Connection failed, will retry
    }

    if (attempt < maxAttempts) {
      process.stdout.write(`  Attempt ${attempt}/${maxAttempts}... waiting\r`);
      await delay(delayMs);
    }
  }

  console.log('\nProxy did not respond in time, attempting CA extraction anyway...');
}

function makeHttpsRequest(host, port, urlPath, sniHostname) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port,
        path: urlPath,
        method: 'GET',
        rejectUnauthorized: false, // Accept self-signed certs
        timeout: 5000,
        // Use SNI hostname for TLS handshake (required when connecting via IP)
        servername: sniHostname || host,
        headers: {
          'Host': sniHostname || host,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

async function extractCaFromVolume() {
  // Use docker cp to extract the CA from the named volume
  // We need to create a temporary container that mounts the volume

  const containerName = 'caddy-ca-extract-temp';

  // Clean up any existing temp container
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });

  // Create a temporary container with the volume mounted
  const createResult = spawnSync(
    'docker',
    [
      'create',
      '--name', containerName,
      '-v', `${VOLUME_NAME}:/data:ro`,
      'alpine:latest',
      'cat', `/data/${CA_PATH_IN_VOLUME}`,
    ],
    { stdio: 'pipe' }
  );

  if (createResult.status !== 0) {
    const stderr = createResult.stderr?.toString().trim();
    if (stderr?.includes('No such volume')) {
      console.error('Caddy data volume does not exist yet. Start the proxy first.');
    } else {
      console.error('Failed to create temp container:', stderr);
    }
    return false;
  }

  // Copy the CA file out
  const cpResult = spawnSync(
    'docker',
    ['cp', `${containerName}:/data/${CA_PATH_IN_VOLUME}`, outputPath],
    { stdio: 'pipe' }
  );

  // Clean up temp container
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });

  if (cpResult.status !== 0) {
    const stderr = cpResult.stderr?.toString().trim();
    if (stderr?.includes('No such file')) {
      console.error('CA certificate not found in volume. The proxy may not have generated it yet.');
      console.error('Make an HTTPS request to trigger CA generation: curl -k https://socket-proxy.local/healthz');
    } else {
      console.error('Failed to copy CA:', stderr);
    }
    return false;
  }

  // Verify the file was created
  if (!existsSync(outputPath)) {
    console.error('CA file was not created at expected path.');
    return false;
  }

  return true;
}

// Run if executed directly
const modulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;

if (invokedPath === modulePath) {
  main().catch((error) => {
    console.error('\n❌ Export failed:', error.message);
    process.exitCode = 1;
  });
}

export { extractCaFromVolume, waitForProxy, installCaOnMacOS };
