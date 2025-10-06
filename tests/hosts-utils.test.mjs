import { describe, expect, it } from 'vitest';
import { computeHostsUpdate, extractHostIps } from '../scripts/lib/hosts-utils.mjs';

describe('hosts utility helpers', () => {
  it('adds a new mapping when none exists', () => {
    const { content, changed, previousIps } = computeHostsUpdate({
      originalContent: '',
      host: 'socket-proxy.local',
      ip: '192.168.64.1',
    });

    expect(content).toBe('192.168.64.1 socket-proxy.local\n');
    expect(changed).toBe(true);
    expect(previousIps).toEqual([]);
  });

  it('deduplicates existing entries and keeps the latest mapping', () => {
    const original = [
      '127.0.0.1 localhost',
      '192.168.0.28 socket-proxy.local',
      '10.0.0.5 socket-proxy.local',
      '::1 ip6-localhost',
      '',
    ].join('\n');

    const { content, changed, previousIps } = computeHostsUpdate({
      originalContent: original,
      host: 'socket-proxy.local',
      ip: '192.168.64.1',
    });

    expect(changed).toBe(true);
    expect(previousIps).toEqual(['192.168.0.28', '10.0.0.5']);
    expect(content).toBe(
      [
        '127.0.0.1 localhost',
        '::1 ip6-localhost',
        '192.168.64.1 socket-proxy.local',
      ].join('\n') + '\n'
    );
  });

  it('detects when no change is required', () => {
    const original = '192.168.64.1 socket-proxy.local\n';

    const { changed, previousIps } = computeHostsUpdate({
      originalContent: original,
      host: 'socket-proxy.local',
      ip: '192.168.64.1',
    });

    expect(changed).toBe(false);
    expect(previousIps).toEqual(['192.168.64.1']);
  });

  it('extracts unique IPs for a given host', () => {
    const content = [
      '# comment row',
      '192.168.0.1 example.local',
      '192.168.0.2 socket-proxy.local alias',
      '10.0.0.5 socket-proxy.local',
      '',
      '10.0.0.5 socket-proxy.local',
    ].join('\n');

    expect(extractHostIps(content, 'socket-proxy.local')).toEqual(['192.168.0.2', '10.0.0.5']);
  });
});
