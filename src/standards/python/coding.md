# Python Coding Standards

## PY-CODING-001: No deprecated datetime UTC helpers
`datetime.utcnow()` and `datetime.utcfromtimestamp()` are deprecated since Python 3.12 and return timezone-naive objects that cause silent comparison bugs. Use `datetime.now(timezone.utc)` and `datetime.fromtimestamp(ts, tz=timezone.utc)`.

## PY-CODING-002: No `os.popen()` — use `subprocess`
`os.popen()` is deprecated since Python 3.0. Use `subprocess.run()` or `subprocess.Popen()` with explicit argument lists. Never pass a string to subprocess when the input contains user data (shell injection risk).

## PY-CODING-003: No `asyncio.get_event_loop()` — use `get_running_loop()`
`asyncio.get_event_loop()` is deprecated in Python 3.10+ and raises a DeprecationWarning. Inside an async context use `asyncio.get_running_loop()`. For creating a new loop in a synchronous entrypoint use `asyncio.run()`.

## PY-CODING-004: `logger.exception()` only inside `except` blocks
`logger.exception()` captures the current exception traceback. Calling it outside an `except` block logs `NoneType: None` as the traceback, which is misleading. Use `logger.error()` outside exception handlers.

## PY-CODING-005: Type hints required on all public functions (Python 3.10+)
All public module-level and class-level functions must have type hints on parameters and return values. Use `from __future__ import annotations` for forward references. `pydantic` or `dataclasses` for data shapes.

## PY-CODING-006: No bare `except:` or `except Exception:` without re-raise or logging
A bare `except` that silently passes hides crashes. Catch the specific exception type. Always either log the error with context (`logger.exception(...)`) or re-raise.

## PY-CODING-007: No mutable default arguments
Default argument values are evaluated once at function definition time. `def f(x=[])` means all callers share the same list. Use `None` as the default and create the mutable value inside the function.

## PY-CODING-008: f-strings over `%`-formatting and `.format()`
Use f-strings for string interpolation in Python 3.6+. `%`-formatting is legacy and `.format()` is more verbose.

## PY-CODING-009: No `import *` in production code
Wildcard imports pollute the namespace and make it impossible to know where a name comes from. Always import explicitly.

## PY-CODING-010: `pathlib.Path` over `os.path` string manipulation
`pathlib.Path` is the modern, object-oriented API for filesystem paths. `os.path.join` string manipulation is error-prone on cross-platform paths.
