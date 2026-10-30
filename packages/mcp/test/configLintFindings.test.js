import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configLintFindings } from '../src/tools/findings.js';
import { admitDeterministic } from '../../../src/utils/deterministicAdmission.js';

// A rule hit on an added line must reach the findings section as a claim with
// provenance, at its real file line, so a host agent cannot silently drop it.

const diff = [{
    filename: 'Dockerfile',
    patch: '@@ -1,3 +1,3 @@\n-FROM python:3.12-slim\n+FROM python:latest\n WORKDIR /app\n-COPY app.py .\n+ADD app.py .',
}];

test('rule hits on added lines become admitted scanner findings at file lines', () => {
    const found = configLintFindings(diff);
    assert.deepEqual(found.map((f) => [f.ruleId, f.line]), [['hadolint/DL3007', 1], ['hadolint/DL3020', 3]]);
    const { admitted, rejected } = admitDeterministic(found, 'scanner', { revision: 'abc' });
    assert.equal(rejected.length, 0);
    assert.equal(admitted[0].deterministic, true);
    assert.equal(admitted[0].blocking, false);
});

test('context lines and removed files produce nothing', () => {
    assert.deepEqual(configLintFindings([{ filename: 'Dockerfile', patch: '@@ -1 +1 @@\n FROM python:latest' }]), []);
    assert.deepEqual(configLintFindings([{ filename: 'Dockerfile', status: 'removed', patch: '@@ -1 +0,0 @@\n-FROM node' }]), []);
});
