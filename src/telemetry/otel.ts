/**
 * OpenTelemetry bootstrap for the ocean-node-bootstrap peer.
 *
 * Loaded via `node --import ./dist/telemetry/otel.js` (see the `start` script and the
 * Dockerfile `CMD`) so the SDK is registered before `dist/index.js` runs. There is no HTTP
 * API worth tracing here, so - unlike ocean-node - no HTTP/Express auto-instrumentation is
 * loaded; only runtime-node (V8 heap, event-loop delay, GC) plus host metrics.
 *
 * Importing this module is always safe: `initTelemetry()` self-disables unless an OTLP
 * endpoint is configured and `TELEMETRY_ENABLED != off`, so an unconfigured process pays
 * nothing and emits nothing. The whole init is wrapped so a telemetry failure can never take
 * the bootstrap down.
 */
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { HostMetrics } from '@opentelemetry/host-metrics'
import { randomUUID } from 'node:crypto'

import { telemetryConfig, type TelemetryConfig } from './config.js'
import { telemetryLog } from './log.js'
import { derivePeerId } from './peerId.js'

let sdk: NodeSDK | undefined
let started = false

export async function initTelemetry(
  env: NodeJS.ProcessEnv = process.env
): Promise<TelemetryConfig> {
  if (started) return telemetryConfig()
  started = true

  const config = telemetryConfig(env)

  if (!config.enabled) {
    if (config.disabledReason) {
      telemetryLog(`disabled - ${config.disabledReason}`)
    }
    return config
  }

  try {
    // service.instance.id is the node's libp2p peerId, derived deterministically from
    // PRIVATE_KEY before libp2p starts. A random UUID is the fallback when the key is
    // missing or malformed, so telemetry still works but the node is not pinnable in
    // dashboards by its peerId.
    const peerId = await derivePeerId(env.PRIVATE_KEY).catch(() => undefined)
    const instanceId = peerId ?? randomUUID()

    const resource = resourceFromAttributes({
      'service.name': config.serviceName,
      'service.version': config.serviceVersion,
      'deployment.environment': config.environment,
      'service.instance.id': instanceId,
      'ocean.node.role': config.role,
      ...(config.networkLabel ? { 'ocean.network': config.networkLabel } : {})
    })

    sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter(),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: config.exportIntervalMs
      }),
      instrumentations: [new RuntimeNodeInstrumentation()]
    })

    sdk.start()

    const hostMetrics = new HostMetrics({ name: config.serviceName })
    hostMetrics.start()

    telemetryLog(
      `enabled - exporting to ${config.endpoint} as service.name=${config.serviceName} ` +
        `(role=${config.role}, instance=${instanceId})`
    )

    // No signal handlers here on purpose. `index.ts` owns SIGINT/SIGTERM and calls
    // `process.exit(0)`; it awaits `shutdownTelemetry()` before exiting so the final metric
    // batch flushes deterministically rather than being killed mid-flush.
  } catch (error) {
    telemetryLog('failed to initialize - continuing without telemetry', error)
  }

  return config
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return
  try {
    await sdk.shutdown()
  } catch (error) {
    telemetryLog('shutdown failed', error)
  }
}

// Auto-start when loaded via `--import`. Top-level await is fine in an ESM module; the
// `started` guard keeps a stray import (a test, or `index.ts`'s lazy shutdown import) from
// starting a second SDK.
await initTelemetry()
