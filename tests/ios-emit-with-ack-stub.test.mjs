import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

/** Returns the source of `func <name>(...) { ... }` by brace matching. */
function functionBody(source, name) {
  const start = source.indexOf(`func ${name}(`);
  expect(start, `func ${name} should exist`).toBeGreaterThan(-1);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Static check only: Swift cannot be compiled on the Linux build host (no Mac on node1).
describe('iOS emitWithAck is a stub that reports UNIMPLEMENTED', () => {
  const swift = stripComments(read('ios/Sources/CapacitorSocketIOPlugin/CapacitorSocketIOPlugin.swift'));

  it('registers the method so the bridge answers it', () => {
    expect(swift).toMatch(/CAPPluginMethod\(name: "emitWithAck", returnType: CAPPluginReturnPromise\)/);
  });

  it('rejects through call.unimplemented and never touches the socket', () => {
    const body = functionBody(swift, 'emitWithAck');
    expect(body).toContain('call.unimplemented(');
    expect(body).not.toContain('socketManager');
    expect(body).not.toContain('resolve(');
    expect(body).not.toContain('workerQueue');
  });
});
