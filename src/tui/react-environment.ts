/**
 * Loads the interactive React/Ink graph through React's production condition,
 * regardless of the caller's ambient mode.
 *
 * React 19's development reconciler writes `performance.measure()` entries for
 * every component on every commit. Node retains those timeline entries until
 * somebody clears them; Darwin's 90 ms busy tick can therefore exhaust the heap
 * during a provider-silent turn. The mode must be selected before the first React
 * import, but it need not leak into later runtime/MCP subprocess construction.
 */
export async function withProductionReactImports<T>(load: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await load();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}
