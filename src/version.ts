/**
 * The service version, as reported by `/v1/gateway/info`.
 *
 * A CONSTANT RATHER THAN AN IMPORT OF `package.json`. Importing the manifest
 * would need a JSON import attribute under NodeNext, would put the whole
 * manifest — including its dependency list — into the shipped bundle, and would
 * make `src/` depend on a file that lives outside it. A constant costs one line.
 *
 * The drift that trade invites is closed by `tests/unit/version.test.ts`, which
 * reads `package.json` and asserts the two agree. So the failure mode is a red
 * test at the same moment you bump the version, not a client being told the
 * wrong number for a release cycle.
 */
export const SERVICE_VERSION = '0.2.1';
