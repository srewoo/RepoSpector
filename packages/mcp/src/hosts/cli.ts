import { spawn } from 'node:child_process';
import { HostError } from '@repospector/core';
import type { CliRunner } from './types.js';

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 32 * 1024 * 1024;

/** Real runner: the user's own gh/glab login; no shell, no prompts, bounded time and output. */
export const runCli: CliRunner = (cmd, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GLAB_NO_PROMPT: '1', NO_COLOR: '1' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.length > MAX_OUTPUT) child.kill('SIGTERM');
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => reject(new HostError(`${cmd} is not available: ${e.message}`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      // stderr from gh/glab names the HTTP error (e.g. 401, 404, 422); it carries no token.
      else reject(new HostError(`${cmd} api failed: ${err.trim().split('\n').slice(0, 2).join(' ').slice(0, 300) || `exit ${code}`}`));
    });
    child.stdin.end(stdin ?? '');
  });
