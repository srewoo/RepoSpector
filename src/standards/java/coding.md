# Java Coding Standards

## JAVA-CODING-001: Never swallow an exception
`catch (Exception e) {}` discards the failure. Log it with context or rethrow — an empty catch block is a defect, not a style preference.

## JAVA-CODING-002: Do not return `null` from a public method
Return `Optional<T>` for a value that may legitimately be absent, or an empty collection for a collection.

## JAVA-CODING-003: Validate constructor arguments
Reference arguments a class stores must be checked with `Objects.requireNonNull` so the failure surfaces at construction rather than at first use, far from the cause.

## JAVA-CODING-004: Inject dependencies through the constructor
Do not `new` a collaborator inside business logic — it cannot be substituted in a test and the dependency is invisible at the call site.

## JAVA-CODING-005: Wrap third-party exceptions at the boundary
Let a domain exception cross a module boundary, not a driver or client library's own exception type.

## JAVA-CODING-006: Handle the failure branch of `CompletableFuture`
A chain without `.exceptionally()` or `.handle()` drops the exception silently.

## JAVA-CODING-007: Protect shared mutable state
Prefer immutable value objects. Where state must be shared and mutated, use `java.util.concurrent` types rather than raw `synchronized` blocks.

## JAVA-CODING-008: No hardcoded secrets
API keys, tokens, passwords, and connection strings must not appear in source.

## JAVA-CODING-009: Suppression requires a stated reason
`@SuppressWarnings` without a comment explaining why the warning does not apply is unreviewable — the next reader cannot tell a considered decision from a silenced one.
