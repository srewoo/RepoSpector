/**
 * Pure filtering logic for `QuickActions`' finding-level action list, pulled
 * out of the `.jsx` component so it can be unit-tested (this repo's jest
 * transform is `^.+\.js$` and there is no React testing library, so `.jsx`
 * files cannot be exercised directly).
 *
 * `QuickActions` always renders `defaultActions` (Explain / How to Fix /
 * False Positive?) plus category-specific actions, but the caller
 * (`PRReviewInterface.handleFindingAction`) may implement only a subset of
 * those ids. Rendering a button with no handler is a dead control — this lets
 * a caller declare the ids it actually implements and have the rest omitted.
 */

/**
 * @param {Array<{id: string}>} actions - the full candidate action list
 * @param {string[]|null} [allowedIds] - ids to keep; `null`/`undefined` means
 *   no filtering (every existing caller that doesn't pass this is unaffected)
 * @returns {Array<{id: string}>}
 */
export function filterActionsByAllowedIds(actions, allowedIds = null) {
    if (!Array.isArray(actions)) return [];
    if (!allowedIds) return actions;
    const allowed = new Set(allowedIds);
    return actions.filter(action => allowed.has(action?.id));
}

export default filterActionsByAllowedIds;
