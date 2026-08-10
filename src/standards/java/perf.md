# Java Performance Standards

## JAVA-PERF-001: No string concatenation inside a loop
`s += x` allocates a new `String` per iteration. Use `StringBuilder`.

## JAVA-PERF-002: Pre-size collections built in a loop
`new ArrayList<>()` that grows to a known size reallocates and copies. Pass the expected size to the constructor.

## JAVA-PERF-003: No `List.contains()` inside a loop
That is O(n) per call and O(n²) overall. Use a `Set`.

## JAVA-PERF-004: No database query inside a loop
Batch the query or express it as a `JOIN` — a per-row query is the N+1 pattern.

## JAVA-PERF-005: No nested iteration over the same collection
Two nested loops over the same collection is O(n²). Build a `Map` for the lookup.

## JAVA-PERF-006: Parallelise independent I/O
Sequential calls with no ordering dependency should run under `CompletableFuture.allOf()`.

## JAVA-PERF-007: Do not use a parallel stream on a small collection
Below roughly 10K elements the fork/join overhead exceeds the benefit.

## JAVA-PERF-008: Avoid autoboxing on hot paths
`List<Integer>` in a tight loop allocates per element. Use a primitive array or a primitive-specialised collection.
