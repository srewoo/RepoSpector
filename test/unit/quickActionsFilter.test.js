/**
 * `filterActionsByAllowedIds` is the pure logic behind `QuickActions`'
 * `allowedIds` prop. `FindingCard` passes `allowedIds={['write-test']}`
 * because `PRReviewInterface.handleFindingAction` implements only that one
 * id — without filtering, Explain / How to Fix / False Positive? render as
 * buttons with no handler.
 */
const { filterActionsByAllowedIds } = require('../../src/utils/quickActionsFilter.js');

const actions = [
    { id: 'explain' },
    { id: 'fix' },
    { id: 'false-positive' },
    { id: 'write-test' },
];

describe('filterActionsByAllowedIds', () => {
    it('returns every action unchanged when allowedIds is not given (default null)', () => {
        expect(filterActionsByAllowedIds(actions)).toEqual(actions);
    });

    it('returns every action unchanged when allowedIds is explicitly null', () => {
        expect(filterActionsByAllowedIds(actions, null)).toEqual(actions);
    });

    it('keeps only the ids in allowedIds', () => {
        expect(filterActionsByAllowedIds(actions, ['write-test'])).toEqual([{ id: 'write-test' }]);
    });

    it('keeps nothing when allowedIds matches none of the actions', () => {
        expect(filterActionsByAllowedIds(actions, ['nonexistent'])).toEqual([]);
    });

    it('preserves order and allows multiple ids', () => {
        expect(filterActionsByAllowedIds(actions, ['write-test', 'explain'])).toEqual([
            { id: 'explain' },
            { id: 'write-test' },
        ]);
    });

    it('is defensive about non-array input', () => {
        expect(filterActionsByAllowedIds(null, ['write-test'])).toEqual([]);
        expect(filterActionsByAllowedIds(undefined)).toEqual([]);
    });
});
