import { wrapUntrusted } from '@repospector/core';

/**
 * Characters per context-pack page. Claude Code stores tool results over ~25k tokens (or ~50 KB) in
 * a file instead of passing them on, so subagents never saw a large pack; pages stay well under that.
 */
export const PAGE_CHARS = 40_000;

export interface PackSection {
  /** Untrusted-content kind (diff, definitions, team-rules). */
  readonly kind: string;
  /** Pieces kept together where possible (one file's diff, one definition). */
  readonly parts: readonly string[];
  /** Trusted guidance placed before the section's content, outside the untrusted block. */
  readonly preface?: string | undefined;
}

function slices(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * Splits the context pack into pages of at most `limit` characters (plus wrapper text). Each page
 * holds whole untrusted blocks, so no block is cut open across pages; a single part longer than a
 * page is split into consecutive blocks.
 */
export function buildPages(sections: readonly PackSection[], limit = PAGE_CHARS): string[] {
  const pages: string[] = [];
  let page = '';
  const place = (block: string): void => {
    if (page && page.length + block.length > limit) {
      pages.push(page);
      page = '';
    }
    page += (page ? '\n' : '') + block;
  };
  for (const s of sections) {
    let group = '';
    let first = true;
    const emit = (): void => {
      if (!group) return;
      place(`${first && s.preface ? `${s.preface}\n` : ''}${wrapUntrusted(s.kind, group)}`);
      first = false;
      group = '';
    };
    for (const part of s.parts.flatMap((p) => slices(p, limit))) {
      if (group && group.length + part.length > limit) emit();
      group += part;
    }
    emit();
  }
  if (page) pages.push(page);
  return pages;
}
