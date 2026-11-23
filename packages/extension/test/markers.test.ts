import { describe, expect, it } from 'vitest';
import { parseMarkerMessage } from '../src/markers.js';

const ok = { type: 'repospector:markers', kind: 'github', findings: [{ id: 'f1', file: 'a.ts', line: 3, status: 'verified', claim: 'x' }] };

describe('parseMarkerMessage', () => {
  it('accepts the expected shape', () => {
    expect(parseMarkerMessage(ok)).toEqual(ok);
  });
  it('rejects other types, hosts, bad lines and oversized lists', () => {
    expect(parseMarkerMessage({ ...ok, type: 'other' })).toBeNull();
    expect(parseMarkerMessage({ ...ok, kind: 'bitbucket' })).toBeNull();
    expect(parseMarkerMessage({ ...ok, findings: [{ ...ok.findings[0], line: 0 }] })).toBeNull();
    expect(parseMarkerMessage({ ...ok, findings: [{ ...ok.findings[0], line: '3' }] })).toBeNull();
    expect(parseMarkerMessage({ ...ok, findings: Array(201).fill(ok.findings[0]) })).toBeNull();
    expect(parseMarkerMessage(null)).toBeNull();
  });
  it('truncates long text instead of trusting it', () => {
    expect(parseMarkerMessage({ ...ok, findings: [{ ...ok.findings[0], claim: 'c'.repeat(5000) }] })?.findings[0]?.claim).toHaveLength(500);
  });
});
