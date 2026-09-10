import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplingStatus, requestCompletion, SAMPLING_UNAVAILABLE } from '../src/sampling.js';
import {
    parseFindings,
    modelFindings,
    deterministicFindings,
    buildFindingsSection,
} from '../src/tools/findings.js';

/**
 * `review_pr` naming defects instead of only supplying evidence.
 *
 * The property that matters most is the negative one. This server is keyless,
 * sampling is an OPTIONAL client capability, and most clients do not implement
 * it — so the common case is that the reasoning pass cannot run at all. When
 * that happens the section must say the check did not happen. An empty findings
 * list that reads as "nothing is wrong" is the exact failure this project
 * exists to prevent, and it is one line of sloppy phrasing away at all times.
 */

/** A client that advertises sampling and answers with `text`. */
const samplingServer = (text, { throws = null, model = 'test-model' } = {}) => ({
    getClientCapabilities: () => ({ sampling: {} }),
    createMessage: async () => {
        if (throws) throw throws;
        return { model, content: { type: 'text', text } };
    },
});

test('a client that does not advertise sampling is detected, not assumed', () => {
    assert.equal(samplingStatus({ getClientCapabilities: () => ({}) }).available, false);
    assert.equal(
        samplingStatus({ getClientCapabilities: () => ({}) }).reason,
        SAMPLING_UNAVAILABLE.NO_CLIENT,
    );
    assert.equal(samplingStatus({ getClientCapabilities: () => ({ sampling: {} }) }).available, true);
});

test('no server connection at all is reported rather than crashing', () => {
    assert.equal(samplingStatus(null).available, false);
    assert.equal(samplingStatus({}).reason, SAMPLING_UNAVAILABLE.NOT_CONNECTED);
});

test('a client refusal is an unavailable check, never an error state', async () => {
    const out = await requestCompletion(
        samplingServer(null, { throws: new Error('user declined') }),
        { prompt: 'x' },
    );
    assert.equal(out.available, false);
    assert.equal(out.text, null);
    assert.match(out.reason, /user declined/);
});

test('an empty completion is reported as empty, not as a clean review', async () => {
    const out = await requestCompletion(samplingServer('   '), { prompt: 'x' });
    assert.equal(out.text, null);
    assert.equal(out.reason, SAMPLING_UNAVAILABLE.EMPTY);
});

test('the model that answered is reported, since the client chooses it', async () => {
    const out = await requestCompletion(samplingServer('{"findings":[]}', { model: 'claude-x' }), { prompt: 'x' });
    assert.equal(out.model, 'claude-x');
});

test('findings parse from bare JSON, a fenced block, or JSON after prose', () => {
    const expected = [{ file: 'a.py', line: 1, title: 't' }];
    assert.deepEqual(parseFindings('{"findings":[{"file":"a.py","line":1,"title":"t"}]}'), expected);
    assert.deepEqual(parseFindings('```json\n{"findings":[{"file":"a.py","line":1,"title":"t"}]}\n```'), expected);
    assert.deepEqual(parseFindings('Here you go:\n{"findings":[{"file":"a.py","line":1,"title":"t"}]}'), expected);
    assert.deepEqual(parseFindings('{"findings":[]}'), []);
});

test('unparseable output is null — distinct from an empty findings list', () => {
    // The distinction the whole contract rests on: [] means the model looked
    // and found nothing; null means the check failed.
    assert.equal(parseFindings('I could not review this.'), null);
    assert.equal(parseFindings(''), null);
    assert.deepEqual(parseFindings('{"findings":[]}'), []);
});

test('unparseable model output marks the pass as NOT run', async () => {
    const out = await modelFindings(samplingServer('sorry, prose not JSON'), { hunks: 'diff' });
    assert.equal(out.available, false);
    assert.deepEqual(out.findings, []);
    assert.match(out.reason, /could not be parsed/);
    assert.ok(out.raw, 'the unparsed text is retained so the failure is inspectable');
});

test('a clean model verdict is available:true with an empty list', async () => {
    const out = await modelFindings(samplingServer('{"findings":[]}'), { hunks: 'diff' });
    assert.equal(out.available, true);
    assert.deepEqual(out.findings, []);
    assert.equal(out.reason, null);
});

test('model findings are labelled asserted-and-unchecked, never validated', async () => {
    const section = await buildFindingsSection({
        server: samplingServer('{"findings":[{"file":"a.py","line":3,"severity":"high","title":"boom"}]}'),
        diffFiles: [],
        indexer: null,
        prData: { files: [] },
        hunks: 'diff',
    });
    const f = section.findings.find((x) => x.source === 'llm');
    assert.equal(f.assertionLevel, 'model-asserted');
    assert.equal(f.validationStatus, 'unvalidated');
    assert.match(section.note, /CANDIDATES asserted by a model and checked by nothing/);
    assert.match(section.note, /refute each one/);
});

test('with no sampling, the section says the check did not run', async () => {
    const section = await buildFindingsSection({
        server: { getClientCapabilities: () => ({}) },
        diffFiles: [],
        indexer: null,
        prData: { files: [] },
        hunks: 'diff',
    });

    assert.equal(section.modelPass.ran, false);
    assert.match(section.modelPass.reason, /did not advertise/);
    // The sentence that stops an empty list reading as an all-clear.
    assert.match(section.note, /THE MODEL PASS DID NOT RUN/);
    assert.match(section.note, /NOT evidence that the change is clean/);
    // And it is an incompleteness in the project's own vocabulary.
    assert.match(section.completeness, /Incomplete review/);
    assert.match(section.completeness, /required check unavailable: model-generated findings/);
});

test('a completed model pass carries no incompleteness warning', async () => {
    const section = await buildFindingsSection({
        server: samplingServer('{"findings":[]}'),
        diffFiles: [],
        indexer: null,
        prData: { files: [] },
        hunks: 'diff',
    });
    assert.equal(section.modelPass.ran, true);
    assert.equal(section.completeness, null);
});

test('the deterministic finders are WIRED — they fire on input that should fire', async () => {
    // Guards against the failure mode that "0 findings" hides: a finder that is
    // not connected looks exactly like one that found nothing. This diff adds a
    // newly exported symbol with no test, which `missingTestFinder` reports.
    // The finder deliberately stays quiet unless the PR ALREADY touches a test
    // file — "telling a docs-only PR that it lacks tests is noise" — so the
    // fixture includes one that covers something else. That gate is also why
    // MR !445, which touches no test, correctly yields nothing here.
    const prData = {
        headSha: 'head1',
        files: [
            {
                filename: 'src/pricing.py',
                patch: [
                    '@@ -1,2 +1,6 @@',
                    ' import os',
                    '+',
                    '+def calculate_widget_price(items):',
                    '+    return sum(i.price for i in items)',
                    '+',
                ].join('\n'),
                additions: 4,
                deletions: 0,
            },
            {
                filename: 'test/unit/test_other.py',
                patch: '@@ -1,2 +1,3 @@\n import unittest\n+# unrelated to the new symbol\n',
                additions: 1,
                deletions: 0,
            },
        ],
    };

    const out = await deterministicFindings(prData.files, null, prData);
    assert.deepEqual(out.errors, [], 'no finder should have errored');
    assert.ok(
        out.findings.length > 0,
        'the missing-test finder produced nothing on a newly exported, untested symbol — '
        + 'it is probably not wired',
    );
});

test('deterministic findings are admitted as graph-inferred, and cannot block', async () => {
    const prData = {
        headSha: 'head1',
        files: [
            {
                filename: 'src/pricing.py',
                patch: '@@ -1,2 +1,4 @@\n import os\n+\n+def calculate_widget_price(items):\n+    return 1\n',
                additions: 3,
                deletions: 0,
            },
            {
                filename: 'test/unit/test_other.py',
                patch: '@@ -1,2 +1,3 @@\n import unittest\n+# unrelated\n',
                additions: 1,
                deletions: 0,
            },
        ],
    };
    const section = await buildFindingsSection({
        server: { getClientCapabilities: () => ({}) },
        diffFiles: prData.files,
        indexer: null,
        prData,
        hunks: 'diff',
        revision: 'head1',
    });

    assert.ok(section.counts.deterministic > 0);
    for (const f of section.findings.filter((x) => x.source !== 'llm')) {
        assert.equal(f.blocking, false, 'an inference must not block a merge on its own');
        assert.ok(f.attribution, 'admitted findings carry provenance');
    }
});

test('a finder that throws is recorded, and does not take the section down', async () => {
    const section = await buildFindingsSection({
        server: { getClientCapabilities: () => ({}) },
        diffFiles: [],
        // A pipeline shaped wrongly makes the graph finder throw.
        indexer: { pipeline: { graph: { findNodeByName: () => { throw new Error('bad graph'); } } } },
        prData: { files: [{ filename: 'a.py', patch: '@@ -1 +1,2 @@\n a\n+def f():\n' }] },
        hunks: 'diff',
    });
    assert.ok(Array.isArray(section.findings));
});
