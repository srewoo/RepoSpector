import type { ReviewTarget } from '@repospector/core';
import type { ReviewFinding } from './pipeline/engine.js';

const MARKER_TIMEOUT_MS = 8_000;

export interface MarkerResult {
  readonly placed: number;
  readonly total: number;
}

/**
 * Injects the marker script into the pull request tab (allowed only on hosts the user granted) and
 * sends it the findings. Returns how many were placed, or null if the page could not be marked.
 */
export async function showMarkers(tabId: number, target: ReviewTarget, findings: readonly ReviewFinding[]): Promise<MarkerResult | null> {
  const message = { type: 'repospector:markers', kind: target.kind, findings: findings.slice(0, 200).map(({ id, file, line, status, claim }) => ({ id, file, line, status, claim })) };
  const attempt = async (): Promise<MarkerResult | null> => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['markers.js'] });
    const reply = await chrome.tabs.sendMessage<MarkerResult | undefined>(tabId, message);
    return reply && typeof reply.placed === 'number' ? reply : null;
  };
  // Injection waits for the page to load; a page that never finishes must not leave the panel waiting.
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), MARKER_TIMEOUT_MS));
  try {
    return await Promise.race([attempt(), timeout]);
  } catch {
    return null; // tab closed, navigated away, or not a page we may script
  }
}

export function markerNote(r: MarkerResult | null, kind: ReviewTarget['kind']): string {
  if (!r || r.total === 0) return r ? '' : 'Could not mark the findings on this page.';
  const where = kind === 'github' ? 'Files changed' : 'Changes';
  if (r.placed === r.total) return `Marked ${r.placed === 1 ? 'the finding' : `all ${r.placed} findings`} beside the diff with "RS".`;
  return `Marked ${r.placed} of ${r.total} findings beside the diff with "RS". The rest are on lines not shown yet: open ${where} or expand the file.`;
}
