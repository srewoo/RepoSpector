import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../static/manifest.json', import.meta.url), 'utf8')) as Record<string, unknown>;

describe('manifest', () => {
  it('is MV3 with a module service worker and a side panel', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: 'sw.js', type: 'module' });
    expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
  });

  it('asks for no hosts at install: hosts are optional and requested at runtime', () => {
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://localhost/*']);
    expect(JSON.stringify(manifest)).not.toContain('<all_urls>');
    expect(manifest.content_scripts).toBeUndefined();
  });

  it('uses a minimal permission set', () => {
    // scripting: inject the diff-marker script on demand, only into tabs on hosts the user granted.
    expect(manifest.permissions).toEqual(['sidePanel', 'storage', 'offscreen', 'scripting']);
    // Local mode only: requested when the user turns it on.
    expect(manifest.optional_permissions).toEqual(['nativeMessaging']);
  });

  it('allows WebAssembly (tree-sitter) but no remote or inline script', () => {
    const csp = (manifest.content_security_policy as { extension_pages: string }).extension_pages;
    expect(csp).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
  });
});
