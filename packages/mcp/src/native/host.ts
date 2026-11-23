#!/usr/bin/env node
import { VERSION } from '../server.js';
import { loadConfig } from './config.js';
import { handleNative } from './handler.js';
import { frame, FrameReader } from './protocol.js';

/**
 * The native messaging host Chrome starts for the extension's local mode. stdout carries only framed
 * replies (anything else would corrupt the channel); diagnostics go to stderr. Requests are answered
 * one at a time, in order; the process ends when Chrome closes stdin.
 */
const reader = new FrameReader();
let chain: Promise<void> = Promise.resolve();

const reply = (message: unknown): void => {
  try {
    process.stdout.write(frame(message));
  } catch (e) {
    process.stdout.write(frame({ ok: false, reason: 'error', message: (e as Error).message }));
  }
};

process.stdin.on('data', (chunk: Buffer) => {
  let messages;
  try {
    messages = reader.push(chunk);
  } catch (e) {
    console.error(`[repospector-native] ${(e as Error).message}`);
    process.exit(1);
  }
  for (const m of messages) {
    chain = chain.then(async () => {
      if (!m.ok) return reply({ ok: false, reason: 'bad-request', message: m.error });
      try {
        reply(await handleNative(m.message, { config: () => loadConfig(), version: VERSION }));
      } catch (e) {
        console.error('[repospector-native]', e);
        reply({ ok: false, reason: 'error', message: 'the local program failed; see its log' });
      }
    });
  }
});
process.stdin.on('end', () => void chain.then(() => process.exit(0)));
