# Python Performance Standards

## PY-PERF-001: No nested comprehension building a large intermediate
A comprehension inside a comprehension materialises the inner result for every outer item. Split it into named steps, or use a generator so the intermediate is never built.

## PY-PERF-002: No blocking I/O inside an async function
A synchronous `requests` call, `open()`, or `time.sleep` inside `async def` blocks the event loop and stalls every other coroutine. Use the async client, or hand the work to a thread executor.

## PY-PERF-003: No nested iteration over the same collection
Two nested loops over the same sequence is O(n²). Build a `dict` or `set` for the lookup.

## PY-PERF-004: Hoist invariant lookups out of loops
Attribute chains, `len()` on an unchanging sequence, and recompiled regexes belong above the loop, not inside it.
