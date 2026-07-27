/**
 * Deterministic premise gates for the finding verifier.
 *
 * Every case here is drawn from the measured 50-MR run in which the LLM verifier
 * passed 42 of 42 findings that independent triple-lens adjudication rejected
 * (precision 0%, 95% CI [0, 8.4%]). These checks are mechanical, so they belong
 * in code — asking a model to confirm "does this line exist" is what let the
 * hallucinated locations through.
 *
 * The FALSE-REFUTATION suite matters more than the refutation suite: wrongly
 * dropping a real finding is the expensive direction, and an over-eager gate is
 * how this fix would do harm.
 */

const {
    assessFinding,
    claimedConstructs,
    dedupeFindings,
    EVIDENCE,
} = require('../../src/utils/findingEvidence.js');

const patch = (lines) => ['@@ -1,4 +1,8 @@', ...lines].join('\n');

describe('claimedConstructs', () => {
    it('extracts backticked and dotted constructs from the title', () => {
        expect(claimedConstructs({ title: 'Use of deprecated `datetime.utcnow()`' })).toContain('datetime.utcnow');
        expect(claimedConstructs({ title: 'Use of ast.literal_eval with untrusted data' })).toContain('ast.literal_eval');
    });

    it('extracts long snake_case identifiers quoted without backticks', () => {
        expect(claimedConstructs({ title: 'Typo in conumser_linger_ms parameter' })).toContain('conumser_linger_ms');
    });

    it('drops a bare tail already covered by a qualified name', () => {
        // `ast.literal_eval` also yields `literal_eval`; treating them as two
        // independent claims made a present construct look half-absent and
        // falsely refuted a real finding.
        const c = claimedConstructs({ title: 'Use of ast.literal_eval with untrusted data' });
        expect(c).toContain('ast.literal_eval');
        expect(c).not.toContain('literal_eval');
    });

    it('ignores prose, short words and file paths', () => {
        const c = claimedConstructs({ title: 'Error handling is weak here, e.g. in utils.py' });
        expect(c).toHaveLength(0);
    });

    it('reads only the title, not the suggested fix in the description', () => {
        // A description usually names the REPLACEMENT, which is legitimately
        // absent from the code. Mixing them makes absence unprovable.
        const c = claimedConstructs({
            title: 'Use of deprecated `datetime.utcnow()`',
            description: 'Replace it with datetime.now(timezone.utc) instead.',
        });
        expect(c).toEqual(['datetime.utcnow']);
    });
});

describe('assessFinding — refutations (all were real false positives)', () => {
    it('refutes a cited line that is not in the diff', () => {
        const r = assessFinding(
            { file: 'a.py', line: 900, title: 'Blocking call in async function' },
            patch([' ctx', '+await run(x)'])
        );
        expect(r.verdict).toBe(EVIDENCE.REFUTED);
        expect(r.reason).toMatch(/not present in the diff/);
    });

    it('refutes a construct that appears only on REMOVED lines', () => {
        // "deprecated makeSuite" on a diff whose only makeSuite lines are deletions:
        // the finding flags exactly what the MR fixed.
        const r = assessFinding(
            { file: 'test.py', line: 1, title: 'Use of deprecated unittest.makeSuite()' },
            patch(['-suite.addTest(unittest.makeSuite(T))', '+suite.addTest(loader.loadTestsFromTestCase(T))'])
        );
        expect(r.verdict).toBe(EVIDENCE.REFUTED);
        expect(r.reason).toMatch(/only on REMOVED lines/);
    });

    it('is not fooled by the construct surviving in a comment', () => {
        // A `# makeSuite` note explaining the removal must not count as the call
        // still being present.
        const r = assessFinding(
            { file: 'test.py', line: 2, title: 'Use of deprecated unittest.makeSuite()' },
            patch(['-suite.addTest(unittest.makeSuite(T))', '+# makeSuite was removed here', '+suite.addTest(other)'])
        );
        expect(r.verdict).toBe(EVIDENCE.REFUTED);
    });

    it('refutes a construct absent from the file entirely', () => {
        const r = assessFinding(
            { file: 'a.py', line: 1, title: 'Use of deprecated `datetime.utcnow()`' },
            patch(['+ts = datetime.now(timezone.utc)'])
        );
        expect(r.verdict).toBe(EVIDENCE.REFUTED);
        expect(r.reason).toMatch(/does not appear/);
    });

    it('refutes a construct that exists only inside a comment', () => {
        // Comments are not code: a comment mentioning json.Unmarshal does not
        // mean the call is there to ignore an error.
        const r = assessFinding(
            { file: 'a.go', line: 1, title: 'Error return value ignored from json.Unmarshal' },
            patch(['+// json.Unmarshal is handled by the caller'])
        );
        expect(r.verdict).toBe(EVIDENCE.REFUTED);
        expect(r.reason).toMatch(/does not appear in this file's code/);
    });
});

describe('assessFinding — must NOT refute (false-refutation guard)', () => {
    it('keeps a finding whose construct really is in the added code', () => {
        const r = assessFinding(
            { file: 'a.py', line: 1, title: 'Use of ast.literal_eval with untrusted data' },
            patch(['+data = ast.literal_eval(raw)'])
        );
        expect(r.verdict).toBe(EVIDENCE.GROUNDED);
    });

    it('keeps a finding that names no specific construct', () => {
        // Nothing to disprove mechanically — that is the LLM's job, not this gate's.
        const r = assessFinding(
            { file: 'a.py', line: 1, title: 'Credentials returned to the caller' },
            patch(['+return {"accessKeyId": k}'])
        );
        expect(r.verdict).toBe(EVIDENCE.UNPROVEN);
    });

    it('keeps everything when the patch is unavailable', () => {
        const r = assessFinding({ file: 'a.py', line: 2, title: 'Uses `foo.bar()`' }, '');
        expect(r.verdict).toBe(EVIDENCE.UNPROVEN);
    });

    it('keeps a finding on a context line inside the diff', () => {
        // Real defects can sit on untouched lines the change now depends on.
        const r = assessFinding(
            { file: 'a.py', line: 1, title: 'Missing guard around `cache.get()`' },
            patch([' cache.get(key)', '+use(value)'])
        );
        expect(r.verdict).not.toBe(EVIDENCE.REFUTED);
    });

    it('keeps a construct present on added lines even if also removed elsewhere', () => {
        const r = assessFinding(
            { file: 'a.py', line: 1, title: 'Unsafe `os.system()` call' },
            patch(['-os.system(old)', '+os.system(new)'])
        );
        expect(r.verdict).toBe(EVIDENCE.GROUNDED);
    });
});

describe('dedupeFindings', () => {
    it('collapses the same defect reported twice at adjacent lines', () => {
        const { kept, duplicates } = dedupeFindings([
            { file: 'a.js', line: 32, title: 'Use === instead of == for comparison' },
            { file: 'a.js', line: 33, title: 'Use === instead of == for comparison' },
        ]);
        expect(kept).toHaveLength(1);
        expect(duplicates).toHaveLength(1);
    });

    it('keeps the same defect class at distant lines — those are separate instances', () => {
        const { kept } = dedupeFindings([
            { file: 'a.js', line: 10, title: 'Empty catch block swallows the error' },
            { file: 'a.js', line: 200, title: 'Empty catch block swallows the error' },
        ]);
        expect(kept).toHaveLength(2);
    });

    it('keeps the same title in different files', () => {
        const { kept } = dedupeFindings([
            { file: 'a.js', line: 10, title: 'Potential SSRF via unvalidated host' },
            { file: 'b.js', line: 10, title: 'Potential SSRF via unvalidated host' },
        ]);
        expect(kept).toHaveLength(2);
    });

    it('is insensitive to line numbers embedded in the title text', () => {
        const { kept } = dedupeFindings([
            { file: 'a.js', line: 5, title: 'Line 5 uses == for comparison' },
            { file: 'a.js', line: 6, title: 'Line 6 uses == for comparison' },
        ]);
        expect(kept).toHaveLength(1);
    });
});

describe('assessIntent — documented deliberate behaviour', () => {
    const { assessIntent } = require('../../src/utils/findingEvidence.js');

    it('refutes a "silently swallowed" claim when the handler is documented', () => {
        // Real case: the reviewer called this silent; the next line explains it.
        const r = assessIntent(
            { line: 1, title: 'Empty catch block swallows the error silently' },
            patch(['+} catch (_) {', '+  // corrupted or unavailable — fall through to default', '+}'])
        );
        expect(r.verdict).toBe(EVIDENCE.REFUTED);
        expect(r.reason).toMatch(/documented/);
    });

    it('matches on presence of an explanation, not on keywords', () => {
        // A keyword list missed the real cases — they share no vocabulary.
        const r = assessIntent(
            { line: 1, title: 'Swallowed exception' },
            patch(['+except Exception:  # never change the pod exit code on upload failure', '+    pass'])
        );
        expect(r.verdict).toBe(EVIDENCE.REFUTED);
    });

    it('does NOT excuse a TODO or FIXME — that is known debt worth flagging', () => {
        const r = assessIntent(
            { line: 1, title: 'Empty catch block swallows the error' },
            patch(['+} catch (e) {', '+  // TODO: handle this properly before launch', '+}'])
        );
        expect(r.verdict).not.toBe(EVIDENCE.REFUTED);
    });

    it('does NOT excuse a tooling pragma', () => {
        const r = assessIntent(
            { line: 1, title: 'Empty catch swallows the error' },
            patch(['+} catch (e) {', '+  // eslint-disable-next-line no-empty', '+}'])
        );
        expect(r.verdict).not.toBe(EVIDENCE.REFUTED);
    });

    it('refutes a behaviour-change claim on a feature-flag cleanup', () => {
        const r = assessIntent(
            { line: 1, title: 'Behavior scope change in is_recorder' },
            patch(['-    if feature_flag_enabled:', '-        legacy_path()', '+    new_path()'])
        );
        expect(r.verdict).toBe(EVIDENCE.REFUTED);
        expect(r.reason).toMatch(/feature-flag/);
    });

    it('leaves an undocumented empty catch alone — that IS a real finding', () => {
        const r = assessIntent(
            { line: 1, title: 'Empty catch block swallows the error' },
            patch(['+} catch (e) {', '+}'])
        );
        expect(r.verdict).toBe(EVIDENCE.UNPROVEN);
    });

    it('leaves unrelated claims alone', () => {
        const r = assessIntent(
            { line: 1, title: 'SQL injection via string concatenation' },
            patch(['+q = "SELECT * FROM t WHERE id=" + uid  // build query'])
        );
        expect(r.verdict).toBe(EVIDENCE.UNPROVEN);
    });
});
