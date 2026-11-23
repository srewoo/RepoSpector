import { describe, expect, it } from 'vitest';
import { apiBase, detectReviewPage, hostOrigins, normalizeOrigin, type HostSetting } from '../src/settings.js';

const hosts: HostSetting[] = [
  { kind: 'github', origin: 'https://github.com' },
  { kind: 'gitlab', origin: 'https://gitlab.corp.example' },
];

describe('normalizeOrigin', () => {
  it('accepts a bare https host, with or without a trailing slash, lowercased', () => {
    expect(normalizeOrigin('https://GitLab.Corp.Example/')).toBe('https://gitlab.corp.example');
    expect(normalizeOrigin('https://ghe.example:8443')).toBe('https://ghe.example:8443');
  });

  it.each(['http://gitlab.example', 'https://gitlab.example/group', 'https://user:pw@gitlab.example', 'https://gitlab.example?x=1', 'ftp://x', 'gitlab.example', 'https://*.example'])(
    'rejects %s',
    (input) => expect(() => normalizeOrigin(input)).toThrow(),
  );
});

describe('apiBase and hostOrigins', () => {
  it('maps github.com to api.github.com, GitHub Enterprise to /api/v3, GitLab to /api/v4', () => {
    expect(apiBase({ kind: 'github', origin: 'https://github.com' })).toBe('https://api.github.com');
    expect(apiBase({ kind: 'github', origin: 'https://ghe.example' })).toBe('https://ghe.example/api/v3');
    expect(apiBase({ kind: 'gitlab', origin: 'https://gitlab.com' })).toBe('https://gitlab.com/api/v4');
  });

  it('asks for exactly the page origin and the API origin', () => {
    expect(hostOrigins({ kind: 'github', origin: 'https://github.com' })).toEqual(['https://github.com/*', 'https://api.github.com/*']);
    expect(hostOrigins({ kind: 'gitlab', origin: 'https://gitlab.corp.example' })).toEqual(['https://gitlab.corp.example/*']);
  });
});

describe('detectReviewPage', () => {
  it('recognises PR and MR pages on configured hosts only', () => {
    expect(detectReviewPage('https://github.com/o/r/pull/5/files', hosts)).toMatchObject({ kind: 'github', number: 5 });
    expect(detectReviewPage('https://gitlab.corp.example/g/p/-/merge_requests/9', hosts)).toMatchObject({ kind: 'gitlab', iid: 9 });
    expect(detectReviewPage('https://gitlab.com/g/p/-/merge_requests/9', hosts)).toBeNull();
    expect(detectReviewPage('https://github.com/o/r/issues/5', hosts)).toBeNull();
  });

  it('does not let a GitLab-shaped URL on a GitHub host pass, or the reverse', () => {
    expect(detectReviewPage('https://github.com/g/p/-/merge_requests/9', hosts)).toBeNull();
    expect(detectReviewPage('https://gitlab.corp.example/o/r/pull/5', hosts)).toBeNull();
  });
});
