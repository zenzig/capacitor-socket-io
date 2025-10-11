#!/usr/bin/env node

import { rimraf } from 'rimraf';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const env = {
  ...process.env,
  ROLLUP_DISABLE_NATIVE: process.env.ROLLUP_DISABLE_NATIVE ?? '1',
  npm_config_rollup_disable_native: process.env.npm_config_rollup_disable_native ?? 'true',
};

async function main() {
  await rimraf(path.join(repoRoot, 'dist'));

  runCommand(resolveBin('tsc'));
  runCommand(resolveBin('rollup'), ['-c', path.join(repoRoot, 'rollup.config.mjs')]);
}

function resolveBin(name) {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  return path.join(repoRoot, 'node_modules', '.bin', `${name}${ext}`);
}

function runCommand(command, args = []) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main().catch((error) => {
  console.error('[build-dist] Failed to produce distributable artifacts:', error);
  process.exit(1);
});
