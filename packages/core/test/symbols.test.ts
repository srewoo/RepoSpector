import { describe, expect, it } from 'vitest';
import { changedSymbols } from '../src/symbols.js';

const diff = (path: string, body: string): string =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}`;

const names = (text: string): string[] => changedSymbols(text).map((s) => s.name);

describe('changedSymbols', () => {
  it('finds definitions on added and removed lines across languages', () => {
    const text = [
      diff('a.py', '@@ -1,2 +1,2 @@\n-def get_user_scopes(org):\n+def get_user_scopes(org, user):\n     pass\n'),
      diff('b.go', '@@ -1,2 +1,2 @@\n-func (s *Service) FetchDashboard(ctx context.Context) error {\n+func (s *Service) FetchDashboard(ctx context.Context, uid string) error {\n }\n'),
      diff('c.rb', '@@ -1,1 +1,1 @@\n-  def topic_ids_for(user)\n+  def topic_ids_for(user, opts)\n'),
      diff('d.ts', '@@ -1,1 +1,1 @@\n-export const buildBookingUrl = (id: string) => id;\n+export const buildBookingUrl = async (id: string) => id;\n'),
      diff('E.java', '@@ -1,1 +1,1 @@\n-    public UserModel getUserByEmail(RealmModel realm, String email) {\n+    public UserModel getUserByEmail(RealmModel realm, String email, boolean exact) {\n'),
    ].join('');
    expect(names(text)).toEqual(expect.arrayContaining(['get_user_scopes', 'FetchDashboard', 'topic_ids_for', 'buildBookingUrl', 'getUserByEmail']));
  });

  it('marks a definition that only appears on removed lines as removed, and ranks it first', () => {
    const text = diff('a.ts', '@@ -1,3 +1,2 @@\n-interface Props { onClose?: () => void }\n-function legacyHandler() {}\n+function newHandler() {}\n');
    const syms = changedSymbols(text);
    expect(syms.find((s) => s.name === 'legacyHandler')).toMatchObject({ change: 'removed', file: 'a.ts' });
    expect(syms.find((s) => s.name === 'newHandler')?.change).toBe('defined');
    expect(syms.at(-1)?.name).toBe('newHandler');
  });

  it('catches a removed TS interface field', () => {
    const text = diff('Card.tsx', '@@ -1,4 +1,3 @@\n interface CardProps {\n-  isDisabled?: boolean;\n   title: string;\n }\n');
    expect(changedSymbols(text)).toEqual([expect.objectContaining({ name: 'isDisabled', change: 'removed' })]);
  });

  it('does not treat object-literal keys as fields', () => {
    const text = diff('q.ts', '@@ -1,1 +1,4 @@\n+  where: {\n+    scheduledDate: true,\n+    retryCount: { gt: 1 }\n+  bookingUid: string;\n');
    expect(names(text)).toEqual(['bookingUid']);
  });

  it('ignores control-flow keywords, short or generic names, and context lines', () => {
    const text = diff(
      'a.ts',
      '@@ -1,3 +1,4 @@\n function untouchedContext() {}\n+  if (x) {\n+  for (const a of b) {\n+function init() {}\n+function go() {}\n',
    );
    expect(names(text)).toEqual([]);
  });

  it('keeps definitions removed with a deleted file and skips test files', () => {
    const text =
      'diff --git a/old.py b/old.py\ndeleted file mode 100644\n--- a/old.py\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-def gone_helper():\n' +
      diff('tests/test_x.py', '@@ -0,0 +1,1 @@\n+def test_something_works():\n');
    expect(names(text)).toEqual(['gone_helper']);
  });

  it('dedupes by name and caps the list', () => {
    const body = Array.from({ length: 40 }, (_, i) => `+function handler${i}() {}\n`).join('') + '+function handler0() {}\n';
    const syms = changedSymbols(diff('a.ts', `@@ -0,0 +1,41 @@\n${body}`), 10);
    expect(syms).toHaveLength(10);
    expect(new Set(syms.map((s) => s.name)).size).toBe(10);
  });
});
