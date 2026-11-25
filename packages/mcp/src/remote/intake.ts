import { createHash } from 'node:crypto';
import { assessRisk, calledNames, isSafeRepoPath, isSecretPath, parseUnifiedDiff, type ReviewTarget } from '@repospector/core';
import { MAX_FILE_BYTES, MemorySource } from './memory-source.js';

export class IntakeError extends Error {}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** One changed file as a GitHub/GitLab MCP tool reports it: the hunk text without file headers. */
export interface ChangedFileInput {
  readonly path: string;
  readonly previousPath?: string | undefined;
  readonly status: FileStatus;
  /** Hunks starting with "@@"; absent for binary or very large files. */
  readonly patch?: string | undefined;
}

export interface PrInput {
  readonly headSha: string;
  readonly baseSha: string;
  readonly title?: string | undefined;
  /** Pull/merge request description (searched for linked issues and tickets). */
  readonly body?: string | undefined;
  /** Re-review: the earlier reviewed head and the files changed since it (from your host's compare or commit tools). */
  readonly changedSince?: { readonly sha: string; readonly files: readonly string[] } | undefined;
  /** Either a full unified diff... */
  readonly diff?: string | undefined;
  /** ...or the changed files with their patches. */
  readonly files?: readonly ChangedFileInput[] | undefined;
}

export interface FileInput {
  readonly path: string;
  readonly content: string;
  readonly encoding?: 'utf8' | 'base64' | undefined;
  /** Git blob id the host reported (GitHub contents `sha`, GitLab `blob_id`); checked when given. */
  readonly blobSha?: string | undefined;
}

export interface PrData {
  readonly headSha: string;
  readonly baseSha: string;
  readonly title: string;
  readonly body: string;
  readonly diff: string;
  /** Changed files the host gave no patch for (binary or too large). */
  readonly noPatch: string[];
  readonly changedSince?: { readonly sha: string; readonly files: ReadonlySet<string> } | undefined;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const MAX_DIFF_CHARS = 5 * 1024 * 1024;

/** Git's blob id: sha1("blob <size>\0" + bytes); matches GitHub's contents `sha` and GitLab's `blob_id`. */
export function gitBlobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function assertPath(p: string): void {
  if (!isSafeRepoPath(p)) throw new IntakeError(`unsafe path: ${p.slice(0, 200)}`);
}

function fileDiff(f: ChangedFileInput): string {
  const from = f.previousPath ?? f.path;
  const head = [`diff --git a/${from} b/${f.path}`];
  if (f.status === 'added') head.push('new file mode 100644', '--- /dev/null', `+++ b/${f.path}`);
  else if (f.status === 'deleted') head.push('deleted file mode 100644', `--- a/${from}`, '+++ /dev/null');
  else {
    if (f.status === 'renamed' && from !== f.path) head.push(`rename from ${from}`, `rename to ${f.path}`);
    head.push(`--- a/${from}`, `+++ b/${f.path}`);
  }
  const patch = f.patch ?? '';
  return `${head.join('\n')}\n${patch}${patch.endsWith('\n') || !patch ? '' : '\n'}`;
}

/** Validates the pull/merge request data and turns per-file patches into one unified diff. */
export function normalizePr(input: PrInput): PrData {
  const headSha = input.headSha.toLowerCase();
  const baseSha = input.baseSha.toLowerCase();
  if (!SHA.test(headSha) || !SHA.test(baseSha)) throw new IntakeError('headSha and baseSha must be full commit ids (40 hex characters)');
  if ((input.diff === undefined) === (input.files === undefined)) throw new IntakeError('give exactly one of diff (unified diff text) or files (changed files with patches)');
  const noPatch: string[] = [];
  let diff = input.diff ?? '';
  if (input.files) {
    for (const f of input.files) {
      assertPath(f.path);
      if (f.previousPath) assertPath(f.previousPath);
      if (f.patch && !f.patch.startsWith('@@')) throw new IntakeError(`patch for ${f.path} must start with "@@" (hunks only, no file headers)`);
      if (!f.patch && f.status !== 'deleted') noPatch.push(f.path);
    }
    diff = input.files.filter((f) => f.patch || f.status === 'deleted').map(fileDiff).join('');
  }
  if (diff.length > MAX_DIFF_CHARS) throw new IntakeError(`diff is over ${MAX_DIFF_CHARS / 1024 / 1024} MB`);
  for (const f of parseUnifiedDiff(diff)) assertPath(f.path);
  let changedSince: PrData['changedSince'];
  if (input.changedSince) {
    const sha = input.changedSince.sha.toLowerCase();
    if (!SHA.test(sha)) throw new IntakeError('changedSince.sha must be a full commit id');
    input.changedSince.files.forEach(assertPath);
    changedSince = { sha, files: new Set(input.changedSince.files) };
  }
  return { headSha, baseSha, title: (input.title ?? '').slice(0, 500), body: (input.body ?? '').slice(0, 20_000), diff, noPatch, ...(changedSince ? { changedSince } : {}) };
}

/** Changed files whose content at the head the review needs: reviewable, not deleted, not secret. */
export function neededFiles(diff: string): string[] {
  return assessRisk(parseUnifiedDiff(diff)).reviewable.map((f) => f.path);
}

/** Names the diff's added lines call, construct or extend: where they are defined is repository context. */
export function definitionNames(diff: string): string[] {
  return calledNames(diff).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

export interface FilesResult {
  readonly stored: { path: string; lines: number; verified: boolean }[];
  readonly refused: { path: string; reason: string }[];
}

function decode(f: FileInput): Buffer {
  return f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8');
}

/**
 * The content that matches the blob id. Some MCP tools drop a file's final newline when they show
 * text, so that one difference is repaired; anything else is a mismatch (null).
 */
function matchBlob(bytes: Buffer, blob: string): Buffer | null {
  if (gitBlobId(bytes) === blob) return bytes;
  const withNewline = Buffer.concat([bytes, Buffer.from('\n')]);
  return gitBlobId(withNewline) === blob ? withNewline : null;
}

/** Stores files at the head commit. Unsafe paths, secrets, binaries, oversize files and blob-id mismatches are refused. */
export function acceptFiles(source: MemorySource, files: readonly FileInput[]): FilesResult {
  const stored: FilesResult['stored'] = [];
  const refused: FilesResult['refused'] = [];
  for (const f of files) {
    const path = f.path.replace(/^\/+/, '');
    if (!isSafeRepoPath(path)) refused.push({ path: f.path.slice(0, 200), reason: 'unsafe path' });
    else if (isSecretPath(path)) refused.push({ path, reason: 'possible secrets: never sent to a model' });
    else {
      const raw = decode(f);
      const blob = f.blobSha?.toLowerCase();
      const bytes = blob ? matchBlob(raw, blob) : raw;
      if (raw.length > MAX_FILE_BYTES) refused.push({ path, reason: 'over 2 MB' });
      else if (raw.includes(0)) refused.push({ path, reason: 'binary' });
      else if (!bytes) refused.push({ path, reason: `content does not match blob ${blob?.slice(0, 12)}; pass the file exactly as fetched at the head commit, or leave blobSha out` });
      else {
        const text = bytes.toString('utf8');
        const limit = source.set(path, text, Boolean(blob), bytes.length);
        if (limit) refused.push({ path, reason: limit });
        else stored.push({ path, lines: source.lineCount(path) ?? 0, verified: Boolean(blob) });
      }
    }
  }
  return { stored, refused };
}

export interface Intake {
  readonly id: string;
  readonly url: string;
  readonly target: ReviewTarget;
  readonly source: MemorySource;
  pr?: PrData;
}
