/**
 * Node's test runner uses the child process's stdout for its own IPC
 * protocol (test-result framing). The ported extension services
 * (RAGService.js, VectorStore.js, ...) call console.log directly — dozens of
 * lines per indexing/retrieval run — and that output interleaves with the
 * runner's own protocol frames on the same stream, which occasionally
 * corrupts a frame the parent process is trying to deserialize
 * ("Unable to deserialize cloned data due to invalid or unsupported
 * version."). It is intermittent because it depends on exact interleaving
 * timing, not on anything the test itself asserts — reruns can look green
 * while the hazard is still there.
 *
 * `src/index.js` already solved this for the real server, because stdout is
 * literally the MCP transport there:
 *
 *   console.log = (...args) => console.error(...args);
 *
 * Any test file that imports code which transitively imports the extension
 * services (via repo/indexer.js) needs the same redirect, and needs it
 * BEFORE those imports run, since some of that logging happens at module
 * side-effects. Import this file first, for its side effect only:
 *
 *   import '../testSupport/silenceServiceLogs.js'; // must be the first import
 *
 * This file lives in packages/mcp/testSupport/, a sibling of test/, not
 * anywhere under test/ itself — including a subdirectory such as
 * test/helpers/. Node's test runner in directory mode (`node --test test/`,
 * which this package's `npm test` uses) collects and executes EVERY .js file
 * nested anywhere under a `test`-named ancestor, with no *.test.js naming
 * filter once that ancestor matches. A helper placed under test/ becomes a
 * phantom test that passes trivially (it declares no test() calls) but
 * inflates the reported test count and forces the next person to re-diagnose
 * the mismatch. This is the same sweep rule that already forced the
 * mini-repo fixture out from under test/ to packages/mcp/fixtures/ (see
 * test/index_repo.test.js) — testSupport/ mirrors that precedent for
 * non-fixture test infrastructure.
 */
console.log = (...args) => console.error(...args);
