// Bun test preload. Tests exercise the dev build path of the framework by default.
// Individual tests that need to verify prod-only behavior flip this flag locally.
(globalThis as Record<string, unknown>).__koze_DEV__ = true;
