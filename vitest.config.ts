import { defineConfig } from 'vitest/config';

/**
 * Unit suite. Every glob is QUOTED here and in `package.json` scripts —
 * an unquoted `**` in a POSIX `sh` script is expanded by the shell, which
 * silently narrows the set of files that run (a workspace landmine).
 *
 * The integration suite lives in its own config so `pnpm test --run` can never
 * accidentally boot a model runtime.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Each test file boots its own express listeners on ephemeral ports; a
    // single fork keeps port churn and log interleaving predictable.
    pool: 'forks',
    testTimeout: 20_000,
  },
});
