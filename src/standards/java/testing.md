# Java Testing Standards

## JAVA-TEST-001: Every public method must have at least one test
A public method new or modified in this PR needs a corresponding `<ClassName>Test.java` case exercising it.

## JAVA-TEST-002: Unit tests make no real network, filesystem, or database calls
Mock the collaborator. A unit test that reaches a real dependency is an integration test and belongs in a separate source set tagged `@Tag("integration")`.

## JAVA-TEST-003: Cover branches with `@ParameterizedTest`
Logic with multiple branches must be exercised per branch via `@ParameterizedTest` + `@MethodSource`, not by one test asserting the happy path.

## JAVA-TEST-004: Test names state behaviour and condition
Follow `should_<expected>_when_<condition>`. A name like `test1` or `testCreate` says nothing when it fails in CI.

## JAVA-TEST-005: Assert on the outcome, not merely that nothing threw
A test whose body calls the method and asserts nothing still passes when the method is gutted.

## JAVA-TEST-006: No `Thread.sleep` in tests
Synchronise with `CountDownLatch`, `Awaitility`, or a completed future. A sleep is both slow and flaky.
