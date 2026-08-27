/**
 * Telemetry configuration, parsed once from the environment.
 *
 * Telemetry is a **hard no-op** unless an OTLP endpoint is configured and the master
 * switch is not turned off. This module depends on nothing but `process.env`, so importing
 * it can never pull the OpenTelemetry SDK into the import graph ahead of the `--import`
 * bootstrap - keeping it side-effect-free is what lets `metrics.ts` be imported from
 * `index.ts` cheaply.
 */

export type TelemetryConfig = {
  /** Master switch: an OTLP endpoint is set and TELEMETRY_ENABLED is not 'off'. */
  enabled: boolean
  /** Why telemetry is off, for a single startup log line. `undefined` when enabled. */
  disabledReason?: string
  endpoint?: string
  serviceName: string
  serviceVersion: string
  environment: string
  exportIntervalMs: number
  /** `bootstrap` | `relay` - the node's ROLE, surfaced as `ocean.node.role`. */
  role: string
  /** Optional operator tag (`OCEAN_NETWORK_LABEL`) to group fleets, as `ocean.network`. */
  networkLabel?: string
}

/**
 * Positive **integer** milliseconds, or the fallback.
 *
 * `Number(env.X)` alone is not enough: `X=""` yields `0` and `X=abc` yields `NaN`, and both
 * then reach the OTel export interval as a busy loop or an immediate throw. Integrality is
 * part of the contract - `0.1` is finite and positive but a 0.1 ms interval is a busy loop.
 */
export function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

let cached: TelemetryConfig | undefined

export function telemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  if (cached) return cached

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined
  const enabled = env.TELEMETRY_ENABLED !== 'off' && !!endpoint

  cached = {
    enabled,
    endpoint,
    serviceName: env.OTEL_SERVICE_NAME?.trim() || 'ocean-node-bootstrap',
    serviceVersion: env.npm_package_version || '0.0.0',
    environment: env.DEPLOYMENT_ENVIRONMENT || env.NODE_ENV || 'development',
    exportIntervalMs: readPositiveInt(env.OTEL_METRIC_EXPORT_INTERVAL, 60_000),
    role: env.ROLE?.trim() || 'bootstrap',
    networkLabel: env.OCEAN_NETWORK_LABEL?.trim() || undefined,
    disabledReason: enabled
      ? undefined
      : 'OTEL_EXPORTER_OTLP_ENDPOINT unset or TELEMETRY_ENABLED=off'
  }
  return cached
}

/** Test-only: drop the memoized config so a test can re-parse a mutated environment. */
export function resetTelemetryConfigForTest(): void {
  cached = undefined
}
