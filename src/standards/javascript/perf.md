# JavaScript / TypeScript Performance Standards

## JS-PERF-001: No array or object spread inside a loop
`acc = [...acc, item]` inside a loop copies the whole accumulator every iteration, turning an O(n) build into O(n²). Push into the array, or spread once after the loop.

## JS-PERF-002: No nested iteration over the same collection
Two nested loops over the same array is O(n²). Build a `Map` or `Set` keyed by the lookup field and index into it.

## JS-PERF-003: Hoist invariant work out of hot paths
Object literals, regex literals, and derived arrays that do not depend on the loop variable must be created once above the loop, not per iteration.

## JS-PERF-004: Await independent work concurrently
Sequential `await`s on operations with no ordering dependency serialise work that could overlap. Use `Promise.all`.
