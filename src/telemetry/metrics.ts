/**
 * Every OTel instrument the bootstrap emits, defined once at module load.
 *
 * This module depends on `@opentelemetry/api` **only** - never on the SDK. Without a
 * registered provider the API returns no-op instruments, so `add()` calls and the observable
 * gauges cost approximately nothing when telemetry is unconfigured. That is what lets the
 * instrumentation be imported unconditionally from `index.ts`; the SDK is registered only by
 * the `--import` bootstrap in `otel.ts`.
 *
 * Metric names are the P2P catalog from the metrics plan (§4). Labels are bounded enums only -
 * never a peerId, multiaddr or IP (§9). The observable gauge *instruments* live here; their
 * callbacks are attached from `gauges.ts`, which owns the libp2p handle.
 */
import { metrics, type Attributes } from '@opentelemetry/api'

const meter = metrics.getMeter('ocean-node-bootstrap', process.env.npm_package_version)

/* ── Counters ─────────────────────────────────────────────────────────────────── */

export const p2pPeerConnect = meter.createCounter('ocean.p2p.peer.connect', {
  description: 'libp2p peer:connect events observed',
  unit: '{event}'
})

export const p2pPeerDisconnect = meter.createCounter('ocean.p2p.peer.disconnect', {
  description: 'libp2p peer:disconnect events observed',
  unit: '{event}'
})

export const p2pPeerDiscovery = meter.createCounter('ocean.p2p.peer.discovery', {
  description: 'libp2p peer:discovery events observed',
  unit: '{event}'
})

export const rabbitmqPublished = meter.createCounter(
  'ocean.bootstrap.rabbitmq.published',
  {
    description: 'Peer-update messages accepted by the RabbitMQ discovery feed',
    unit: '{message}'
  }
)

/* ── Observable gauges (callbacks attached in gauges.ts) ──────────────────────── */

export const p2pConnections = meter.createObservableGauge('ocean.p2p.connections', {
  description: 'Live libp2p connections, by direction and circuit-relay-limited flag',
  unit: '{connection}'
})

export const p2pRoutingTablePeers = meter.createObservableGauge(
  'ocean.p2p.dht.routing_table_peers',
  {
    description: 'Peers in the Kademlia DHT routing table',
    unit: '{peer}'
  }
)

export const p2pDhtMode = meter.createObservableGauge('ocean.p2p.dht.mode', {
  description: 'DHT mode: 1 = server, 0 = client (restores ocean_bootstrap_dht_mode)',
  unit: '{mode}'
})

export const p2pRelayReservations = meter.createObservableGauge(
  'ocean.p2p.relay_reservations',
  {
    description: 'Circuit-relay reservations (granted when relay server, else held)',
    unit: '{reservation}'
  }
)

export const p2pDialQueue = meter.createObservableGauge('ocean.p2p.dial_queue', {
  description: 'Pending entries in the libp2p dial queue, by status',
  unit: '{dial}'
})

/** Narrow alias so call sites cannot accidentally pass an unbounded value as an attribute. */
export type MetricAttributes = Attributes
