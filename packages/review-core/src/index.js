/**
 * @repospector/review-core — public API.
 *
 * Re-exports the orchestration modules so both the Chrome extension and the
 * Aegis backend import from one place. The actual source still lives at
 * src/services/ in the extension repo to keep webpack/vite happy without a
 * tsconfig rewrite — these files re-export from there.
 *
 * Migration path: when we lift the monorepo to Turborepo proper, the source
 * moves into packages/review-core/src/<file>.js and src/services/<file>.js
 * becomes the re-export shim. For now we do the reverse so day-1 wiring is
 * a pure addition.
 */

export {
    PHASE, SEVERITY, VERDICT, CATEGORY,
    toCanonicalFinding, makeFindingId, rollupVerdict,
    buildVerdictReport, partitionByPhase,
} from './reviewSchema.js';

export {
    DEFAULT_THRESHOLDS as SKIP_THRESHOLDS,
    classifyChanges, evaluateSkipRules,
} from './SkipRuleEngine.js';

export {
    DEFAULT_OPTS as CHUNKER_DEFAULTS,
    shouldChunk, buildBrief, chunkMR,
} from './MRChunker.js';

export {
    buildAssignedHunks, buildAssignedHunksFromDiff, filterToAssignedHunks,
} from './FindingsNormalizer.js';

export { ReviewOrchestrator } from './ReviewOrchestrator.js';
