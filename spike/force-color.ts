/**
 * Forces chalk's color detection on, for suites that assert ANSI is *present*.
 *
 * Must be the first import of the suite: chalk decides color support when its
 * module evaluates, and under `pnpm test` stdout is a pipe, where it would
 * otherwise emit nothing and a "styling happened" assertion would pass vacuously.
 */
process.env['FORCE_COLOR'] = '3';
