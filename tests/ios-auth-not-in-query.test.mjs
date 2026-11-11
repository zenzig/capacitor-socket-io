import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// Comments may explain the rule; only code counts.
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

const swiftPath = 'ios/Sources/CapacitorSocketIOPlugin/CapacitorSocketIO.swift';

/** Returns the source of `private func <name>(...) ... { ... }` by brace matching. */
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

// Static check only: Swift cannot be compiled on the Linux build host. A device/Xcode build is still required.
describe('iOS keeps the auth credential out of the URL query', () => {
  const swift = stripComments(read(swiftPath));

  it('has no auth-to-query merge helpers', () => {
    expect(swift).not.toContain('convertAuthPayloadToQuery');
    expect(swift).not.toContain('combinedQueryParams');
    expect(swift).not.toMatch(/stringValue\(forAuth/);
  });

  it('feeds .connectParams from the caller query only, never from authPayload', () => {
    const build = functionBody(swift, 'buildConfiguration');
    expect(build).not.toContain('authPayload');
    expect(build).not.toMatch(/auth/i);
    const connectParams = build.match(/\.connectParams\(([^)]*)\)/);
    expect(connectParams, '.connectParams should still carry the caller query').not.toBeNull();
    expect(build).toContain('configuration.query');
  });

  it('sends the auth payload through connect(withPayload:)', () => {
    const connect = functionBody(swift, 'connectInternal');
    expect(connect).toContain('configuration.authPayload');
    expect(connect).toContain('client.connect(withPayload: payload)');
    expect(connect).toContain('client.connect(withPayload: payload, timeoutAfter:');
  });
});
