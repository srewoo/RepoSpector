import { parseReviewUrl, type ReviewTarget } from '@repospector/core';
// zod/mini: same validation, tree-shakeable, so extension pages stay small.
import * as z from 'zod/mini';

/** A git host the user added. Origin is scheme + host (+ port), nothing else. */
export const HostSettingSchema = z.strictObject({ kind: z.enum(['github', 'gitlab']), origin: z.string() });
export type HostSetting = z.infer<typeof HostSettingSchema>;
export const HostListSchema = z.array(HostSettingSchema).check(z.maxLength(50));

/** https://host[:port], lowercased; anything with a path, query, credentials or wildcard is refused. */
export function normalizeOrigin(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(trimmed)) throw new Error('enter the host as https://host or https://host:port, without a path');
  return trimmed.toLowerCase();
}

export function apiBase(h: HostSetting): string {
  if (h.kind === 'gitlab') return `${h.origin}/api/v4`;
  return h.origin === 'https://github.com' ? 'https://api.github.com' : `${h.origin}/api/v3`;
}

/** Host permissions to request for this host: the page origin, plus api.github.com for github.com. */
export function hostOrigins(h: HostSetting): string[] {
  const api = new URL(apiBase(h)).origin;
  return [...new Set([`${h.origin}/*`, `${api}/*`])];
}

/** The PR/MR a page shows, if the page is on a host the user added and of that host's kind. */
export function detectReviewPage(url: string, hosts: readonly HostSetting[]): ReviewTarget | null {
  let target: ReviewTarget;
  try {
    target = parseReviewUrl(url);
  } catch {
    return null;
  }
  const origin = `https://${target.host}`;
  return hosts.some((h) => h.origin === origin && h.kind === target.kind) ? target : null;
}
