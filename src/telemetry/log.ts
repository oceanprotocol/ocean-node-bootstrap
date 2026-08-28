/**
 * Telemetry diagnostics.
 *
 * The bootstrap logs one JSON object per line to the console (see `logEvent` in `index.ts`),
 * so the telemetry bootstrap does the same rather than inventing its own format - the feed
 * stays greppable and machine-readable. `logEvent` itself lives in `index.ts` and is not
 * exported (importing it would pull the whole app graph in ahead of the `--import` SDK
 * bootstrap), so the envelope shape is mirrored here instead.
 *
 * There is no stdout protocol channel to protect in this process, so writing to the console
 * is safe - unlike on-mcp, where stdio is a JSON-RPC channel.
 */

export function telemetryLog(message: string, error?: unknown): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: error === undefined ? 'info' : 'error',
    event: 'telemetry',
    message,
    ...(error === undefined
      ? {}
      : { err: error instanceof Error ? error.message : String(error) })
  })
  if (error === undefined) {
    console.info(line)
  } else {
    console.error(line)
  }
}
