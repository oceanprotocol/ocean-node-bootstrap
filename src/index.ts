import { noise } from '@chainsafe/libp2p-noise'
import { mdns } from '@libp2p/mdns'
import { yamux } from '@chainsafe/libp2p-yamux'

import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { createLibp2p, Libp2p } from 'libp2p'
import { identify, identifyPush } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { dcutr } from '@libp2p/dcutr'
import { kadDHT, passthroughMapper, removePrivateAddressesMapper } from '@libp2p/kad-dht'
import { peerIdFromString, peerIdFromPrivateKey } from '@libp2p/peer-id'
import { privateKeyFromRaw } from '@libp2p/crypto/keys'
import type { OceanNodeKeys } from './@types'
import { autoTLS } from '@ipshipyard/libp2p-auto-tls'
import { keychain } from '@libp2p/keychain'
import { http } from '@libp2p/http'
import { tls } from '@libp2p/tls'
import { bootstrap } from '@libp2p/bootstrap'
import { LevelDatastore } from 'datastore-level'
import { Key } from 'interface-datastore'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http'
import amqp from 'amqplib'
import type { Channel, ChannelModel, RecoveringChannelModel } from 'amqplib'
import { multiaddr } from '@multiformats/multiaddr'
import ipaddr from 'ipaddr.js'
import { createHash } from 'node:crypto'
import {
  p2pPeerConnect,
  p2pPeerDisconnect,
  p2pPeerDiscovery,
  rabbitmqPublished
} from './telemetry/metrics.js'
import { registerBootstrapGauges } from './telemetry/gauges.js'

/** Same defaults as ocean-node `DEFAULT_FILTER_ANNOUNCED_ADDRESSES` */
const DEFAULT_FILTER_ANNOUNCED_ADDRESSES = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4'
] as const

// ---------------------------------------------------------------------------
// Shared constants. These are kept in step with ocean-node and ocean.js - they are not
// local choices. `disjointPaths` / `kBucketSize` / `alpha` are deliberately left alone.
// ---------------------------------------------------------------------------
/** 300 actively rejected most of a ~15k-node fleet */
const BOOTSTRAP_MAX_CONNECTIONS = 5_000
/**
 * a relay's connections are dominated by circuit-relay traffic rather than direct
 * DHT fan-out: every reservation is one long-lived connection from the reserving
 * peer, plus every peer that dials through it while the reservation is open. There
 * is no library-level cap on concurrent relayed dials per reservation, so this
 * multiplies the reservation limit by a deliberately generous per-reservation
 * budget - an idle reservation slot is cheap, a relay refusing an inbound circuit
 * dial because it looks like a connection cap is not.
 */
const RELAY_MAX_RESERVATIONS = 2
const RELAY_CONNECTIONS_PER_RESERVATION = 50
const RELAY_MAX_CONNECTIONS = RELAY_MAX_RESERVATIONS * RELAY_CONNECTIONS_PER_RESERVATION
const DIAL_MAX_PARALLEL = 50
const MAX_PEER_ADDRS_TO_DIAL = 30
const DIAL_TIMEOUT_MS = 15_000
/** libp2p's own default, exposed so it can be tuned without a rebuild */
const MAX_DIAL_QUEUE_LENGTH = 500
/**
 * Inbound admission. libp2p consults `maxConnections` only *after* these two,
 * and their defaults are 10 and 5 - so a cap of 5 000 was unreachable: at most 10
 * inbound upgrades could be in flight at once (each with a 10 s timeout), and a
 * single host was limited to 5 new inbound connections per second. During a
 * fleet-wide reconnect storm - the case the high cap exists for - most inbound
 * dials were refused before the cap was ever looked at.
 */
const MAX_INCOMING_PENDING_CONNECTIONS = 256
const INBOUND_CONNECTION_THRESHOLD = 50

/**
 * bind addresses and ports are hardcoded on purpose.
 * The fleet advertises 9000-9003, and a port config surface would only create a
 * way to bind something nobody is looking for. `/ip6/::` - *not* `/ip6/::1`,
 * which is loopback and made every advertised `/dns6/...` address dead. No wss
 * bind here.
 */
const IPV4_BIND_ADDRESS = '0.0.0.0'
const IPV6_BIND_ADDRESS = '::'
const IPV4_TCP_PORT = 9000
const IPV4_WS_PORT = 9001
const IPV6_TCP_PORT = 9002
const IPV6_WS_PORT = 9003

/** kad-dht stream limits, raised from 100/100 to ocean-node's values */
const DHT_MAX_INBOUND_STREAMS = 500
const DHT_MAX_OUTBOUND_STREAMS = 500

/**
 * peer store lifetime for a peer entry and its addresses, in ms. 48 h.
 *
 * libp2p defaults to a 1 h address lifetime and a 6 h peer lifetime, while a DHT
 * provider record stays valid for 48 h - so a record this node hands out can name
 * a peer whose addresses it has already discarded, leaving the asker a peer ID it
 * cannot dial. Re-learning an address does not help either: storing an address
 * that is already present carries the *previous* `observed` timestamp forward
 * rather than refreshing it, so an unchanged address keeps ageing on its original
 * clock however often identify re-reports it.
 *
 * Both values are the same on purpose: `maxPeerAge` must be >= `maxAddressAge`,
 * or the peer entry is evicted while its addresses are still inside their own
 * lifetime. No env surface - this tracks provider-record validity, which is a
 * property of the protocol rather than of a deployment.
 */
const PEER_STORE_MAX_AGE_MS = 172_800_000

const DEFAULT_MDNS_INTERVAL_MS = 20_000
/**
 * must stay under Docker's default 10 s stop grace, or the bounded
 * shutdown is cut short by SIGKILL (exit 137) in exactly the case it exists for.
 * A deployment that raises `--stop-timeout` / `terminationGracePeriodSeconds`
 * can raise this with `P2P_SHUTDOWN_TIMEOUT_MS`; the default has to be safe on
 * its own.
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000

/** - RabbitMQ discovery feed */
const DEFAULT_RABBITMQ_QUEUE = 'discover_queue'
const RABBITMQ_RECOVERY_INITIAL_DELAY_MS = 1_000
const RABBITMQ_RECOVERY_MAX_DELAY_MS = 30_000
const RABBITMQ_CONNECT_WARN_INTERVAL_MS = 30_000
/**
 * amqplib's recovery `maxRetries` defaults to `Infinity`, and the
 * promise `connect()` returns rejects only once the budget is spent - so an
 * initial `setup` failure meant it never settled at all. Finite, so it always
 * settles. Six attempts against the backoff below is ~61 s, which rides out a
 * broker restart inside a single cycle while still reporting a cold-start
 * failure in bounded time; `RABBITMQ_RESTART_DELAY_MS` then starts another
 * cycle, so overall resilience stays unbounded but no single in-library loop is.
 */
const RABBITMQ_MAX_RECOVERY_ATTEMPTS = 6
/** after a bounded recovery cycle gives up, start a fresh one */
const RABBITMQ_RESTART_DELAY_MS = 30_000
/**
 * upper bound on any single close handshake. A close-ok that never arrives must
 * not be able to spend the whole shutdown budget.
 */
const RABBITMQ_CLOSE_TIMEOUT_MS = 1_000
/** `nofile` headroom over `maxConnections`, */
const NOFILE_HEADROOM_FACTOR = 1.2
/** bound the per-message address list and the dedupe map */
const MAX_MULTIADDRS_PER_MESSAGE = 64
/** one entry per peer, sized for the fleet with headroom; eviction is LRU */
const FINGERPRINT_CACHE_SIZE = 60_000

/**
 * relative to the process CWD (`/usr/src/app` in the image), so the Dockerfile
 * declares a `VOLUME` at the resolved absolute path and the README documents the
 * mount as required - without it this is functionally still a `MemoryDatastore`,
 * just with extra steps.
 */
const DEFAULT_DATASTORE_PATH = './databases/bootstrap-store'
/**
 * the datastore key `@ipshipyard/libp2p-auto-tls` stores the provisioned
 * certificate PEM under (`DEFAULT_CERTIFICATE_DATASTORE_KEY` in that package,
 * which is not part of its public exports, so the literal is mirrored here).
 * Read-only: this process never writes to it, only checks for its presence
 * before `createLibp2p` so startup can log whether autoTLS is about to load an
 * existing certificate from disk or provision a fresh one from Let's Encrypt.
 */
const AUTO_TLS_CERTIFICATE_DATASTORE_KEY = '/libp2p/auto-tls/certificate'

/**
 * loopback-only and deliberately not configurable: a process bound to 127.0.0.1
 * inside a container's network namespace cannot be reached through that
 * container's external interface, even via `docker run -p` - so this is what
 * keeps the admin endpoints from becoming a public unauthenticated surface by
 * accident. Scrape it with `docker exec curl ...`, a sidecar sharing the network
 * namespace, or a reverse proxy running inside the same namespace; see README.
 */
const ADMIN_BIND_ADDRESS = '127.0.0.1'
const DEFAULT_ADMIN_PORT = 9100
/** `/ready` requires the DHT routing table to hold at least this many peers */
const DEFAULT_READY_MIN_ROUTING_TABLE_PEERS = 1

/**
 * any peer-store tag whose name starts with libp2p's `KEEP_ALIVE` constant
 * (`'keep-alive'`) is watched by the connection manager's reconnect queue, which
 * redials the peer on disconnect and on node startup. The plain `'bootstrap'` tag
 * `@libp2p/bootstrap` applies by default only protects a peer from being trimmed
 * under connection pressure - it does not trigger a reconnect, which is the whole
 * point of a seed mesh that is supposed to reform after a restart or a network
 * blip. No `tagTTL` is passed alongside it, so the tag itself never expires.
 */
const BOOTSTRAP_SEED_KEEP_ALIVE_TAG = 'keep-alive-bootstrap-seed'
const BOOTSTRAP_SEED_TAG_VALUE = 100

function envRaw(name: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '' || raw === 'undefined') {
    return undefined
  }
  return raw.trim()
}

function envString(name: string, fallback: string): string {
  return envRaw(name) ?? fallback
}

function envNumber(name: string, fallback: number): number {
  const raw = envRaw(name)
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    console.warn(`Invalid ${name}="${raw}", using ${fallback}`)
    return fallback
  }
  // every consumer is a positive integer - a connection cap, a stream
  // cap or a millisecond budget. `0`, `-1` and `12.7` all parsed cleanly and
  // passed straight through: `P2P_MAX_CONNECTIONS=0` mutes the node and
  // `P2P_connectionsDialTimeout=-1` reaches `AbortSignal.timeout(-1)`.
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `Out-of-range ${name}="${raw}" (expected a positive integer), using ${fallback}`
    )
    return fallback
  }
  return parsed
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = envRaw(name)
  if (raw === undefined) {
    return fallback
  }
  const value = raw.toLowerCase()
  if (value === 'true' || value === '1' || value === 'yes') {
    return true
  }
  if (value === 'false' || value === '0' || value === 'no') {
    return false
  }
  console.warn(`Invalid ${name}="${raw}", using ${fallback}`)
  return fallback
}

type Role = 'bootstrap' | 'relay'

/**
 * `ROLE` locks a whole matrix of knobs together (circuit-relay server,
 * RabbitMQ, `maxConnections`, ...) rather than leaving each one independently
 * settable, which is what let a deployment drift into an invalid combination -
 * e.g. a node that runs the RabbitMQ discovery feed *and* the circuit-relay
 * server. Default is `bootstrap` so an unset `ROLE` never accidentally turns a
 * node into a relay. An unrecognised value is fatal at startup rather than
 * silently falling back, because silently defaulting a role is exactly the kind
 * of drift this exists to prevent.
 */
function getRole(): Role {
  const raw = envRaw('ROLE')
  if (raw === undefined) {
    return 'bootstrap'
  }
  const value = raw.toLowerCase()
  if (value === 'bootstrap' || value === 'relay') {
    return value
  }
  logEvent('error', 'role:invalid', {
    role: raw,
    hint: 'ROLE must be "bootstrap" or "relay" - refusing to silently default'
  })
  process.exit(1)
}

const ROLE: Role = getRole()

/**
 * was a hardcoded `P2P_DEFAULTS` const. Every connection-manager limit is
 * now env-driven (same env names as ocean-node) so a bootstrap can be retuned
 * without a rebuild; supplies the defaults Ports are
 * deliberately *not* here -
 */
const P2P_CONFIG = {
  /** mDNS finds nothing across cloud regions, so it defaults off */
  enableMDNS: envBoolean('P2P_ENABLE_MDNS', false),
  mDNSInterval: envNumber('P2P_mDNSInterval', DEFAULT_MDNS_INTERVAL_MS),
  connectionsMaxParallelDials: envNumber(
    'P2P_connectionsMaxParallelDials',
    DIAL_MAX_PARALLEL
  ),
  connectionsDialTimeout: envNumber('P2P_connectionsDialTimeout', DIAL_TIMEOUT_MS),
  // a relay's connection budget is dominated by circuit-relay traffic rather than
  // direct DHT fan-out, so its default is sized off the reservation limit instead
  // of reusing the bootstrap figure - see RELAY_MAX_CONNECTIONS
  maxConnections: envNumber(
    'P2P_MAX_CONNECTIONS',
    ROLE === 'relay' ? RELAY_MAX_CONNECTIONS : BOOTSTRAP_MAX_CONNECTIONS
  ),
  maxPeerAddrsToDial: envNumber('P2P_MAXPEERADDRSTODIAL', MAX_PEER_ADDRS_TO_DIAL),
  maxDialQueueLength: envNumber('P2P_MAX_DIAL_QUEUE_LENGTH', MAX_DIAL_QUEUE_LENGTH),
  dhtMaxInboundStreams: envNumber('P2P_dhtMaxInboundStreams', DHT_MAX_INBOUND_STREAMS),
  dhtMaxOutboundStreams: envNumber('P2P_dhtMaxOutboundStreams', DHT_MAX_OUTBOUND_STREAMS),
  /** upper bound on graceful shutdown before the process is forced down */
  shutdownTimeout: envNumber('P2P_SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS),
  datastorePath: envString('P2P_DATASTORE_PATH', DEFAULT_DATASTORE_PATH),
  adminPort: envNumber('P2P_ADMIN_PORT', DEFAULT_ADMIN_PORT),
  readyMinRoutingTablePeers: envNumber(
    'P2P_READY_MIN_ROUTING_TABLE_PEERS',
    DEFAULT_READY_MIN_ROUTING_TABLE_PEERS
  )
}

/**
 * the queue name is configurable because queue durability cannot be
 * flipped in place - `assertQueue` with `durable: true` against an existing
 * transient queue fails the channel with 406 PRECONDITION_FAILED. Pointing this
 * and the consumer at a new name makes the migration an env change.
 */
const RABBITMQ_QUEUE = envString('RABBITMQ_QUEUE', DEFAULT_RABBITMQ_QUEUE)

/**
 * `BOOTSTRAP_PEERS` - comma-separated multiaddrs (each ending `/p2p/<peerId>`) of
 * the *other* bootstraps to seed-mesh with. Env-supplied only, deliberately: the
 * default list lives in two other repos already, and a third hardcoded copy here
 * would just be one more place for it to drift out of sync with them.
 */
function getBootstrapPeersFromEnv(): string[] {
  const raw = envRaw('BOOTSTRAP_PEERS')
  if (raw === undefined) {
    return []
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

let libp2p: Libp2p | null = null
let datastore: LevelDatastore | null = null
let adminServer: HttpServer | null = null
let rabbitConnection: RecoveringChannelModel | null = null
let rabbitChannel: Channel | null = null
/** remembered so a spent recovery cycle can be restarted */
let rabbitUrl: string | null = null
let rabbitRestartTimer: NodeJS.Timeout | null = null
/**
 * the connection the recovery `setup` hook is currently working on, which is the
 * only handle onto an attempt that has not been established yet
 */
let pendingModel: ChannelModel | null = null
/**
 * memoises the in-flight close. Two concurrent calls used to split the
 * resources between them - the first took the channel and suspended awaiting its
 * close, the second found the channel already gone, took the connection and closed
 * it, which orphaned the first call's close-ok. The first call then never settled,
 * and since `shutdown()` awaits it, the process sat there until the shutdown
 * timeout fired and exited non-zero. Both callers can genuinely overlap:
 * `shutdown()` and the restart driven off a spent recovery cycle.
 */
let rabbitClosing: Promise<void> | null = null
/**
 * hoisted out of `startRabbitMq` so a close can clear it. It used to be cleared
 * only by the connect promise settling, so a terminal close during an in-flight
 * connect cycle left it running and `rabbitmq:not-connected` kept firing for the
 * life of the process.
 */
let rabbitNotConnectedWarning: NodeJS.Timeout | null = null
/**
 * set by `closeRabbitMq` so a close is terminal for this subsystem even
 * outside process shutdown. Without it the restart cycle was guarded only by
 * `shuttingDown`, so a direct `closeRabbitMq()` was overtaken by the `.catch()`
 * of the recovery cycle still in flight, which scheduled another cycle.
 */
let rabbitStopped = false
let shuttingDown = false
/** one-shot timers owned by the certificate handlers, cleared on shutdown */
const certificateTimers = new Set<NodeJS.Timeout>()
/** peerId -> fingerprint of (sorted multiaddrs + sorted protocols) */
const peerFingerprints = new Map<string, string>()

/** one JSON object per line, so the feed is greppable and machine-readable */
function logEvent(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {}
): void {
  // `...fields` used to come last, so a payload key overwrote the
  // envelope. Both `notifyQueue` call sites pass an `event` field, which made
  // `queue:published` and `queue:skipped-unchanged` render as `"event":"update"`
  // - `grep queue` on a real run found nothing. The envelope is applied twice:
  // first to fix key order, then over `fields` so it always wins.
  const envelope = { ts: new Date().toISOString(), level, event }
  const line = JSON.stringify(Object.assign({ ...envelope }, fields, envelope))
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else if (level === 'debug') {
    console.debug(line)
  } else {
    console.info(line)
  }
}

/** `.name`/`.code` first - `.message` alone loses the class of failure */
function errorFields(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    return {
      err: e.name,
      code: (e as { code?: unknown }).code,
      message: e.message
    }
  }
  return { err: String(e) }
}

/** `P2P_ANNOUNCE_ADDRESSES` — JSON array, same as ocean-node */
function getAnnounceAddressesFromEnv(): string[] {
  const raw = process.env.P2P_ANNOUNCE_ADDRESSES
  if (!raw || raw === 'undefined') {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    console.warn('Invalid P2P_ANNOUNCE_ADDRESSES JSON, ignoring')
    return []
  }
}

/** `P2P_FILTER_ANNOUNCED_ADDRESSES` — JSON CIDR list; unset uses ocean-node defaults */
function getFilterAnnouncedAddressesFromEnv(): string[] {
  const raw = process.env.P2P_FILTER_ANNOUNCED_ADDRESSES
  if (!raw || raw === 'undefined') {
    return [...DEFAULT_FILTER_ANNOUNCED_ADDRESSES]
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.map(String)
      : [...DEFAULT_FILTER_ANNOUNCED_ADDRESSES]
  } catch {
    console.warn('Invalid P2P_FILTER_ANNOUNCED_ADDRESSES JSON, using defaults')
    return [...DEFAULT_FILTER_ANNOUNCED_ADDRESSES]
  }
}

/** `P2P_ANNOUNCE_PRIVATE` — same semantics as ocean-node `booleanFromString` / schema default false */
function getAnnouncePrivateIpFromEnv(): boolean {
  const raw = process.env.P2P_ANNOUNCE_PRIVATE
  if (raw === undefined || raw === '') {
    return false
  }
  return raw === 'true' || raw === '1' || raw.toLowerCase() === 'yes'
}

function shouldAnnounce(
  addr: unknown,
  announcePrivateIp: boolean,
  filterAnnouncedAddresses: string[]
): boolean {
  try {
    const maddr = multiaddr(addr as any)
    const protos = maddr.getComponents()
    // multiaddr v13 dropped nodeAddress() - the host is the value of the
    // leading ip*/dns* component
    const hostComponent = protos.find(
      (entry) =>
        entry.name === 'ip4' ||
        entry.name === 'ip6' ||
        entry.name === 'dns' ||
        entry.name === 'dns4' ||
        entry.name === 'dns6' ||
        entry.name === 'dnsaddr'
    )
    if (hostComponent?.value === undefined) {
      // no host to inspect, e.g. a circuit relay address - same outcome as
      // before, when nodeAddress() threw and we fell through to the catch
      return true
    }
    const addressString = hostComponent.value
    if (
      protos.some(
        (entry) =>
          entry.name === 'dns' ||
          entry.name === 'dns4' ||
          entry.name === 'dns6' ||
          entry.name === 'dnsaddr'
      )
    ) {
      if (addressString === 'localhost' || addressString === '127.0.0.1') {
        return false
      }
      return true
    }

    if (!ipaddr.isValid(addressString)) {
      return false
    }

    const parsedAddr = ipaddr.parse(addressString)
    const range = parsedAddr.range()

    if (range === 'loopback') {
      return false
    }

    for (const filter of filterAnnouncedAddresses) {
      try {
        const parsedCIDR = ipaddr.parseCIDR(filter)
        if ((parsedAddr as any).match(parsedCIDR as any)) {
          return false
        }
      } catch {
        console.error(`Invalid CIDR filter in config: ${filter}`)
      }
    }

    if (announcePrivateIp === false && (range === 'private' || range === 'uniqueLocal')) {
      return false
    }
    return true
  } catch {
    return true
  }
}

/**
 * `maxConnections` defaults to 5 000 and every connection
 * costs at least one file descriptor, but the `nofile` limit is set outside the
 * container's own control - a daemon started with `--default-ulimit nofile=1024`
 * makes the node hit `EMFILE` at ~1 000 connections with nothing in the log to
 * explain it. Node has no `getrlimit` binding, so the effective *soft* limit is
 * read from the process's own diagnostic report (rlimits are inherited, so
 * reading self is correct even though PID 1 in the image is the init shim, not
 * node). Compared against the env-resolved `P2P_CONFIG.maxConnections`, after
 * clamping, so raising the cap moves the threshold with it. The deploy-side requirement is
 * documented in the README.
 */
function checkFileDescriptorLimit(): void {
  const required = Math.ceil(P2P_CONFIG.maxConnections * NOFILE_HEADROOM_FACTOR)
  let soft: unknown
  try {
    const report = process.report?.getReport() as
      { userLimits?: Record<string, { soft?: unknown }> } | undefined
    soft = report?.userLimits?.open_files?.soft
  } catch (e) {
    logEvent('debug', 'ulimit:probe-failed', errorFields(e))
    return
  }
  if (typeof soft !== 'number' || !Number.isFinite(soft)) {
    // reported as 'unlimited' on some platforms, or absent - nothing to compare
    logEvent('debug', 'ulimit:nofile-unknown', { reported: String(soft) })
    return
  }
  if (soft < required) {
    logEvent('warn', 'ulimit:nofile-too-low', {
      soft,
      required,
      maxConnections: P2P_CONFIG.maxConnections,
      headroomFactor: NOFILE_HEADROOM_FACTOR,
      hint: 'raise the nofile hard limit (docker --ulimit nofile=65536:65536, or LimitNOFILE on the daemon); node raises its own soft limit to the hard limit at startup, so the hard limit is what binds. EMFILE will otherwise cap connections well below maxConnections'
    })
  } else {
    logEvent('info', 'ulimit:nofile', {
      soft,
      required,
      maxConnections: P2P_CONFIG.maxConnections
    })
  }
}

/**
 * `datastore-level` has been a declared dependency all along and was never
 * imported - the package-install cost was already paid, only the wiring was
 * missing. Without this, the peer store falls back to libp2p's default
 * `MemoryDatastore`, which wipes two things on every restart: the 48 h peer/address
 * TTL (`PEER_STORE_MAX_AGE_MS`) that makes provider records survivable, and any
 * autoTLS certificate - which then re-runs the ACME flow from scratch and risks a
 * Let's Encrypt rate limit that leaves the node with no TLS address at all.
 *
 * Explicit `.open()` rather than relying on libp2p to call it: `LevelDatastore`
 * only implements `open`/`close`, not libp2p's `start`/`stop` `Startable`
 * lifecycle, so nothing in `createLibp2p`/`node.start()` would ever call it.
 *
 * Returns `null` on failure rather than throwing, so the caller can log a single
 * `startup:aborted` line and exit deliberately instead of an unhandled rejection.
 */
async function openDatastore(): Promise<LevelDatastore | null> {
  const path = P2P_CONFIG.datastorePath
  const store = new LevelDatastore(path)
  try {
    await store.open()
  } catch (e) {
    logEvent('error', 'datastore:open-failed', { path, ...errorFields(e) })
    return null
  }
  // read-only probe, purely to make the startup log line honest about what
  // autoTLS is about to do - this process never writes to this key itself
  let certificateFound = false
  try {
    certificateFound = await store.has(new Key(AUTO_TLS_CERTIFICATE_DATASTORE_KEY))
  } catch (e) {
    logEvent('debug', 'datastore:certificate-probe-failed', errorFields(e))
  }
  logEvent('info', 'datastore:open', {
    path,
    constructorName: store.constructor.name,
    tlsCertificate: certificateFound ? 'loaded-from-disk' : 'not-found-will-provision'
  })
  return store
}

function buildHealthPayload(): { ok: boolean; body: Record<string, unknown> } {
  const status = libp2p?.status ?? 'stopped'
  // liveness, not readiness: a node that is still starting is alive, one that
  // was never created or is on its way down is not
  const ok = libp2p !== null && status !== 'stopping' && status !== 'stopped'
  return {
    ok,
    body: {
      status: ok ? 'ok' : 'unhealthy',
      role: ROLE,
      libp2pStatus: status,
      dhtMode: getDhtMode(),
      peerId: libp2p?.peerId?.toString(),
      uptimeSec: Math.round(process.uptime())
    }
  }
}

/**
 * ready means: libp2p started, at least one confirmed public/TLS listen address,
 * DHT in server mode, and the routing table at or above `P2P_READY_MIN_ROUTING_TABLE_PEERS`.
 */
function buildReadyPayload(): { ok: boolean; body: Record<string, unknown> } {
  const started = libp2p !== null && libp2p.status === 'started'
  const tlsAddresses = getConfirmedTlsAddresses()
  const dhtMode = getDhtMode()
  const routingTableSize = getRoutingTableSize()
  const checks = {
    libp2pStarted: started,
    tlsAddressConfirmed: tlsAddresses.length > 0,
    dhtServerMode: dhtMode === 'server',
    routingTableAboveThreshold: routingTableSize >= P2P_CONFIG.readyMinRoutingTablePeers
  }
  const ok = Object.values(checks).every(Boolean)
  return {
    ok,
    body: {
      status: ok ? 'ready' : 'not-ready',
      role: ROLE,
      checks,
      dhtMode,
      routingTableSize,
      routingTableThreshold: P2P_CONFIG.readyMinRoutingTablePeers,
      tlsAddressCount: tlsAddresses.length
    }
  }
}

function handleAdminRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/'
  try {
    if (url === '/health') {
      const { ok, body } = buildHealthPayload()
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
      return
    }
    if (url === '/ready') {
      const { ok, body } = buildReadyPayload()
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  } catch (e) {
    logEvent('error', 'admin:request-failed', { url, ...errorFields(e) })
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
    }
    res.end(JSON.stringify({ error: 'internal error' }))
  }
}

/**
 * bound to loopback only, deliberately - see `ADMIN_BIND_ADDRESS`. The endpoints and
 * `/health`/`/ready` carry no authentication, so the bind address is the only
 * thing standing between them and the public internet; loopback means `docker run
 * -p` cannot expose them even by operator mistake, which is judged the safer
 * default for a surface nobody asked to make public. Failure to bind is logged
 * but does not take down the p2p node - health being unavailable must
 * never be confused with the node itself being down.
 */
function startAdminServer(): void {
  const server = createServer((req, res) => {
    handleAdminRequest(req, res)
  })
  server.on('error', (e: Error) => {
    logEvent('error', 'admin:server-error', errorFields(e))
  })
  server.listen(P2P_CONFIG.adminPort, ADMIN_BIND_ADDRESS, () => {
    logEvent('info', 'admin:listening', {
      host: ADMIN_BIND_ADDRESS,
      port: P2P_CONFIG.adminPort,
      endpoints: ['/health', '/ready']
    })
  })
  adminServer = server
}

/**
 * a seam, noted here rather than hidden: `@libp2p/circuit-relay-v2` dispatches no
 * event and exposes no public hook for reservation grant/deny, so this reaches
 * into `services.circuitRelay.reservationStore.reserve` - private, unexported
 * internals - to observe the outcome. Defensive about the internal shape
 * changing: if the method is not where expected, this logs once and gives up
 * rather than throwing. `result.expire != null` is used as the grant signal
 * rather than comparing against the library's `Status` enum, because that enum
 * is not part of the package's public exports either; the source comment in
 * `server/index.js` documents `expire` as non-null exactly when the reservation
 * was granted.
 */
function instrumentRelayReservations(node: Libp2p): void {
  const store = (node as any)?.services?.circuitRelay?.reservationStore
  if (!store || typeof store.reserve !== 'function') {
    logEvent('warn', 'relay:reservation-instrumentation-unavailable', {})
    return
  }
  const originalReserve = store.reserve.bind(store)
  store.reserve = (peer: any, addr: any, limit: any) => {
    const result = originalReserve(peer, addr, limit)
    const granted = result?.expire != null
    logEvent(
      granted ? 'info' : 'warn',
      granted ? 'relay:reservation-granted' : 'relay:reservation-denied',
      {
        peerId: peer?.toString?.(),
        status: String(result?.status)
      }
    )
    return result
  }
}

async function start() {
  checkFileDescriptorLimit()
  logEvent('info', 'role:active', { role: ROLE })
  // bound before libp2p so /health and /ready can report a meaningful "not up
  // yet" instead of being unreachable for however long node creation takes
  startAdminServer()

  const store = await openDatastore()
  if (store === null) {
    logEvent('error', 'startup:aborted', { reason: 'datastore failed to open' })
    process.exit(1)
  }
  datastore = store

  libp2p = await createNode(store)
  if (!libp2p) {
    return
  }
  logDhtMode('startup')

  libp2p.addEventListener('peer:connect', (evt: any) => {
    handlePeerConnect(evt)
  })
  libp2p.addEventListener('peer:update', (evt: any) => {
    handlePeerUpdate(evt)
  })
  libp2p.addEventListener('peer:disconnect', (evt: any) => {
    handlePeerDisconnect(evt)
  })
  libp2p.addEventListener('peer:discovery', (details: any) => {
    handlePeerDiscovery(details)
  })
  libp2p.addEventListener('certificate:provision', (evt: any) => {
    handleCertificateProvision(evt)
  })
  libp2p.addEventListener('certificate:renew', (evt: any) => {
    handleCertificateRenew(evt)
  })
  // fires for the local node's own record - new/changed listen addresses,
  // protocol changes - as distinct from `peer:update`, which fires for every
  // *other* peer. DHT mode cannot change here (clientMode is fixed), but
  // routing-table size is worth re-observing on the same trigger.
  libp2p.addEventListener('self:peer:update', (evt: any) => {
    handleSelfPeerUpdate(evt)
  })

  // observable-gauge callbacks over the running libp2p handle. A no-op when telemetry is
  // unconfigured (the meter has no provider), and every probe inside is guarded.
  registerBootstrapGauges(libp2p)

  if (ROLE === 'relay') {
    instrumentRelayReservations(libp2p)
    logEvent('info', 'rabbitmq:disabled', {
      reason: 'ROLE=relay does not run the discovery feed'
    })
  } else {
    const rabbitUrl = envRaw('RABBITMQ_URL')
    if (rabbitUrl) {
      // deliberately not awaited: an unreachable broker must never hold up the p2p
      // node, and the recovery wrapper keeps retrying in the background
      startRabbitMq(rabbitUrl)
    } else {
      logEvent('warn', 'rabbitmq:disabled', { reason: 'RABBITMQ_URL not set' })
    }
  }
}

/**
 * Creates the publishing channel and declares the queue. Runs as
 * the recovery `setup` hook, so it re-runs after every reconnect.
 *
 * `durable: true` is a RabbitMQ 4.x *compatibility* requirement, not just
 * hardening: `{ durable: false }` on a non-exclusive queue is rejected with
 * `541 INTERNAL_ERROR - Feature 'transient_nonexcl_queues' is deprecated`.
 * Without the `'error'` listeners below, such a rejection arrives as an
 * unhandled `'error'` event outside any try/catch and kills the process.
 *
 * no `prefetch`. It is consumer QoS on a channel that only publishes,
 * so it never had any effect here.
 *
 * The `'error'` listener on `model` is the first thing installed, and it has to
 * be. The recovery layer runs this hook on a connection it has not bound yet -
 * its own `'error'` forwarder is attached only once this resolves - so a socket
 * death in this window emits `'error'` on a `ChannelModel` with no listener.
 * `EventEmitter` then throws it, the library rethrows rather than swallowing, and
 * the process dies with an `uncaughtException` that has nothing to do with a
 * defect in this service. Reproducible by resetting the connection while
 * `assertQueue` is in flight. This hook is the only place the model is reachable
 * from, which is why the listener lives here rather than anywhere tidier; while
 * the connection is bound it means such an error is reported twice, under two
 * different event names, which is a fair price for not dying.
 */
async function createRabbitChannel(model: ChannelModel): Promise<void> {
  model.on('error', (err: Error) => {
    logEvent('error', 'rabbitmq:model-error', {
      queue: RABBITMQ_QUEUE,
      ...errorFields(err),
      stack: err?.stack
    })
  })
  // remembered so a close can drop the attempt this hook is running inside. The
  // recovery layer keeps both its retry timer and its connection private until
  // the first attempt succeeds, so before that this is the only handle on it.
  pendingModel = model
  if (rabbitStopped || shuttingDown) {
    // a close landed while this cycle was connecting - do not install a channel
    await model.close().catch(() => {})
    throw new Error('RabbitMQ closed while a connection attempt was in flight')
  }
  try {
    const channel = await model.createChannel()
    channel.on('error', (err: Error) => {
      logEvent('error', 'rabbitmq:channel-error', {
        queue: RABBITMQ_QUEUE,
        ...errorFields(err)
      })
    })
    channel.on('close', () => {
      if (rabbitChannel === channel) {
        rabbitChannel = null
      }
      logEvent('warn', 'rabbitmq:channel-closed', { queue: RABBITMQ_QUEUE })
    })
    await channel.assertQueue(RABBITMQ_QUEUE, { durable: true })
    rabbitChannel = channel
    logEvent('info', 'rabbitmq:channel-ready', {
      queue: RABBITMQ_QUEUE,
      durable: true
    })
  } catch (e) {
    // report it here and now. This runs as amqplib's recovery `setup`
    // hook, and the promise `connect()` returns does not settle until the whole
    // retry budget is spent - so on a cold start a 406/541 was otherwise visible
    // only as a channel-level error line with nothing tying it to startup.
    logEvent('error', 'rabbitmq:setup-failed', {
      queue: RABBITMQ_QUEUE,
      ...errorFields(e)
    })
    throw e
  }
}

/**
 * amqplib 2.x connection recovery (`connectWithRecoveryPromise`, reached
 * through `connect(url, { recovery })`) - reconnect with backoff, jitter and a
 * retry limit, plus a `setup` hook that rebuilds the channel after every
 * successful connection. No hand-rolled reconnect loop.
 *
 * No `heartbeat` option is passed anywhere: amqplib reads `heartbeat` from the
 * URL query string, and passing one here would override the deployed URL.
 *
 * `maxRetries` is finite on purpose. `connect(url, { recovery })` returns
 * `RecoveringCore.waitForConnect()`, which resolves only on a *successful*
 * connect+setup and rejects only once `_attempt >= maxRetries`. With the default
 * `Infinity` neither `.then()` nor `.catch()` ever ran if the first `setup`
 * failed - the durability-migration path, where `assertQueue` answers 406. So
 * `rabbitConnection` stayed `null`, every connection-level listener below was
 * never attached (making `connect-error` and the backoff logging dead code), and
 * `closeRabbitMq()` had nothing to close and could not stop the loop. A bounded
 * budget makes the promise always settle; `scheduleRabbitRestart()` then begins a
 * fresh bounded cycle, so a long broker outage still self-heals without an
 * uncancellable in-library loop - which is also what stops crash window
 * from being re-rolled forever.
 */
function startRabbitMq(url: string): void {
  if (shuttingDown) {
    return
  }
  rabbitStopped = false
  // a new cycle owns new resources, so the previous close no longer describes them
  rabbitClosing = null
  rabbitUrl = url
  clearNotConnectedWarning()
  const notConnectedWarning = setInterval(() => {
    if (!rabbitChannel) {
      logEvent('warn', 'rabbitmq:not-connected', { queue: RABBITMQ_QUEUE })
    }
  }, RABBITMQ_CONNECT_WARN_INTERVAL_MS)
  notConnectedWarning.unref()
  rabbitNotConnectedWarning = notConnectedWarning

  amqp
    .connect(url, {
      recovery: {
        initialDelay: RABBITMQ_RECOVERY_INITIAL_DELAY_MS,
        maxDelay: RABBITMQ_RECOVERY_MAX_DELAY_MS,
        factor: 2,
        jitter: 0.2,
        maxRetries: RABBITMQ_MAX_RECOVERY_ATTEMPTS,
        setup: (model: ChannelModel) => createRabbitChannel(model)
      }
    })
    .then((connection) => {
      clearNotConnectedWarning()
      if (shuttingDown || rabbitStopped) {
        // shutdown, or a close, arrived while the initial connect was in flight
        connection.close().catch(() => {})
        return
      }
      rabbitConnection = connection
      // the connection half of the missing error handling
      connection.on('error', (err: Error) => {
        logEvent('error', 'rabbitmq:connection-error', errorFields(err))
      })
      connection.on('disconnect', (err: Error) => {
        logEvent('warn', 'rabbitmq:disconnected', errorFields(err))
      })
      connection.on('connect-failed', (err: Error) => {
        logEvent('warn', 'rabbitmq:connect-failed', errorFields(err))
      })
      connection.on('reconnect-scheduled', (info: { attempt: number; delay: number }) => {
        logEvent('info', 'rabbitmq:reconnect-scheduled', {
          attempt: info.attempt,
          delayMs: info.delay
        })
      })
      connection.on('reconnect-failed', (err: Error) => {
        logEvent('error', 'rabbitmq:reconnect-failed', errorFields(err))
        // the bounded budget is spent and amqplib will not schedule
        // another attempt, so this instance is finished. Tear it down and start a
        // fresh cycle rather than going quiet for the life of the process.
        restartRabbitMq().catch((e: unknown) => {
          logEvent('error', 'rabbitmq:restart-failed', errorFields(e))
        })
      })
      connection.on('blocked', (reason: string) => {
        logEvent('warn', 'rabbitmq:blocked', { reason })
      })
      connection.on('unblocked', () => {
        logEvent('info', 'rabbitmq:unblocked')
      })
      logEvent('info', 'rabbitmq:connected', { queue: RABBITMQ_QUEUE })
    })
    .catch((e: unknown) => {
      clearNotConnectedWarning()
      logEvent('error', 'rabbitmq:connect-error', errorFields(e))
      scheduleRabbitRestart()
    })
}

/**
 * close whatever is left of a spent recovery cycle, then start another.
 *
 * Returns early once shutdown has begun. This is reached from the
 * `reconnect-failed` handler, which fires exactly when the broker is flapping -
 * i.e. during a redeploy - and without this check it raced the shutdown path for
 * the same channel and connection.
 */
async function restartRabbitMq(): Promise<void> {
  if (shuttingDown) {
    return
  }
  await closeRabbitMq()
  // this close is a step in a restart, not a request to stop
  rabbitStopped = false
  scheduleRabbitRestart()
}

/**
 * one pending restart at a time, suppressed once shutdown has begun so
 * `closeRabbitMq()` is genuinely terminal. The timer is unref'd so it can never
 * be the only thing holding the process open.
 */
function scheduleRabbitRestart(): void {
  if (
    shuttingDown ||
    rabbitStopped ||
    rabbitUrl === null ||
    rabbitRestartTimer !== null
  ) {
    return
  }
  logEvent('warn', 'rabbitmq:restart-scheduled', {
    queue: RABBITMQ_QUEUE,
    delayMs: RABBITMQ_RESTART_DELAY_MS
  })
  const timer = setTimeout(() => {
    rabbitRestartTimer = null
    const url = rabbitUrl
    if (url !== null && !shuttingDown) {
      startRabbitMq(url)
    }
  }, RABBITMQ_RESTART_DELAY_MS)
  timer.unref()
  rabbitRestartTimer = timer
}

/**
 * Publishes one peer update. Fire-and-forget by design.
 *
 * A peer that misses the queue is not a correctness problem for this service: the
 * downstream inventory is a cache of who is reachable, and the peer is published
 * again on its next `peer:update` - which protocol registration alone triggers
 * several times per connection. So this uses a plain channel and reports only
 * whether amqplib accepted the frame; it does not wait for a broker ack, and
 * there is no confirm bookkeeping, backpressure gate or fan-in cap to get wrong.
 *
 * `persistent: true` is kept because it is free: a durable queue whose messages
 * are not persistent loses them all on a broker restart, which is a whole-fleet
 * gap rather than one peer.
 */
function publishToQueue(payload: Record<string, unknown>): boolean {
  const channel = rabbitChannel
  if (!channel) {
    logEvent('warn', 'rabbitmq:dropped', {
      queue: RABBITMQ_QUEUE,
      reason: 'no channel',
      peerId: payload.peerId
    })
    return false
  }
  try {
    return channel.sendToQueue(RABBITMQ_QUEUE, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      contentType: 'application/json'
    })
  } catch (e) {
    logEvent('error', 'rabbitmq:publish-failed', {
      queue: RABBITMQ_QUEUE,
      peerId: payload.peerId,
      ...errorFields(e)
    })
    return false
  }
}

function clearNotConnectedWarning(): void {
  if (rabbitNotConnectedWarning !== null) {
    clearInterval(rabbitNotConnectedWarning)
    rabbitNotConnectedWarning = null
  }
}

/**
 * resolves to `null` if `promise` has not settled inside `timeoutMs`. The promise
 * is abandoned rather than cancelled, so callers must have already attached their
 * own rejection handling to it.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
    timer.unref()
  })
  return Promise.race([promise, expiry]).finally(() => {
    clearTimeout(timer)
  })
}

/**
 * Single-flight. Concurrent callers share one close, which is what makes it
 * re-entrant: without this the callers divided the resources between them and the
 * one holding the channel waited for a close-ok that the other had already made
 * impossible. The memo is dropped in `startRabbitMq`, because a fresh cycle owns
 * fresh resources that this close says nothing about.
 */
function closeRabbitMq(): Promise<void> {
  rabbitClosing ??= doCloseRabbitMq()
  return rabbitClosing
}

async function doCloseRabbitMq(): Promise<void> {
  // a close is terminal. The flag matters as much as the timer: amqplib's
  // recovery cycle may still be in flight and unreachable from here, and when its
  // budget is finally spent the `.catch()` in `startRabbitMq` runs and would
  // otherwise schedule another cycle after this close had returned.
  rabbitStopped = true
  clearNotConnectedWarning()
  if (rabbitRestartTimer !== null) {
    clearTimeout(rabbitRestartTimer)
    rabbitRestartTimer = null
  }
  // Every close below is bounded. A close-ok that never arrives is the normal
  // case when the broker is flapping, and an unbounded wait here is paid for by
  // the whole shutdown: it ran out the shutdown timeout and exited non-zero
  // instead of stopping cleanly.
  const channel = rabbitChannel
  rabbitChannel = null
  if (channel) {
    const closed = await withTimeout(
      channel.close().then(
        () => 'closed',
        (e: unknown) => {
          logEvent('warn', 'rabbitmq:channel-close-failed', errorFields(e))
          return 'failed'
        }
      ),
      RABBITMQ_CLOSE_TIMEOUT_MS
    )
    if (closed === null) {
      logEvent('warn', 'rabbitmq:channel-close-timeout', {
        queue: RABBITMQ_QUEUE,
        timeoutMs: RABBITMQ_CLOSE_TIMEOUT_MS
      })
    } else if (closed === 'closed') {
      logEvent('info', 'rabbitmq:channel-close', { queue: RABBITMQ_QUEUE })
    }
  }
  const connection = rabbitConnection
  rabbitConnection = null
  if (connection) {
    const closed = await withTimeout(
      connection.close().then(
        () => 'closed',
        (e: unknown) => {
          logEvent('warn', 'rabbitmq:connection-close-failed', errorFields(e))
          return 'failed'
        }
      ),
      RABBITMQ_CLOSE_TIMEOUT_MS
    )
    if (closed === null) {
      logEvent('warn', 'rabbitmq:connection-close-timeout', {
        timeoutMs: RABBITMQ_CLOSE_TIMEOUT_MS
      })
    } else if (closed === 'closed') {
      logEvent('info', 'rabbitmq:connection-close')
    }
  }
  // An attempt that never became a connection is reachable only through the
  // model the recovery `setup` hook was handed, so closing that is the only way
  // to drop the socket of an attempt still in flight. The library's own retry
  // timer stays private, so a bounded budget can still run itself out afterwards
  // - but the check at the top of the setup hook means those attempts install
  // nothing and say nothing, and the stopped flag keeps a restart from being
  // scheduled. That is what makes a close terminal in practice.
  const model = pendingModel
  pendingModel = null
  if (model) {
    await withTimeout(
      model.close().then(
        () => undefined,
        () => undefined
      ),
      RABBITMQ_CLOSE_TIMEOUT_MS
    )
  }
}

/**
 * stop libp2p so peers drop the connection instead
 * of holding a dead one, then close the RabbitMQ channel and connection, under a
 * bounded timeout.
 *
 * NOTE: this only runs if the container actually delivers the signal. Node as
 * PID 1 with no init never receives SIGTERM from `docker stop`, so the
 * Dockerfile half of (`dumb-init` / `--init`) must land for these handlers
 * to execute at all.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logEvent('debug', 'shutdown:already-in-progress', { signal })
    return
  }
  shuttingDown = true
  logEvent('info', 'shutdown:start', {
    signal,
    timeoutMs: P2P_CONFIG.shutdownTimeout
  })
  const forceExit = setTimeout(() => {
    logEvent('error', 'shutdown:timeout', {
      signal,
      timeoutMs: P2P_CONFIG.shutdownTimeout
    })
    process.exit(1)
  }, P2P_CONFIG.shutdownTimeout)
  try {
    for (const timer of certificateTimers) {
      clearTimeout(timer)
    }
    certificateTimers.clear()
    const server = adminServer
    adminServer = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      logEvent('info', 'shutdown:admin-server-stopped')
    }
    const node = libp2p
    libp2p = null
    if (node) {
      try {
        await node.stop()
        logEvent('info', 'shutdown:libp2p-stopped')
      } catch (e) {
        logEvent('error', 'shutdown:libp2p-stop-failed', errorFields(e))
      }
    }
    await closeRabbitMq()
    const store = datastore
    datastore = null
    if (store) {
      try {
        await store.close()
        logEvent('info', 'shutdown:datastore-closed')
      } catch (e) {
        logEvent('error', 'shutdown:datastore-close-failed', errorFields(e))
      }
    }
    // flush the final metric batch before exit. Lazy import so the OTel SDK is never pulled
    // into the graph from here - it is already loaded via `--import`, so this resolves from
    // the module cache, and `shutdownTelemetry()` is a no-op when telemetry is disabled.
    try {
      const { shutdownTelemetry } = await import('./telemetry/otel.js')
      await shutdownTelemetry()
    } catch (e) {
      logEvent('error', 'shutdown:telemetry-flush-failed', errorFields(e))
    }
    logEvent('info', 'shutdown:complete', { signal })
  } finally {
    clearTimeout(forceExit)
  }
  process.exit(0)
}

/**
 * was a `setInterval` used as a one-shot - it logged and then cleared
 * itself on the first tick, including when `libp2p` was null. (: an earlier
 * revision of this comment claimed the null case leaked the interval. It did not;
 * baseline cleared it.) Settled into a single tracked `setTimeout` - the delay
 * exists because the autoTLS address appears shortly after the event - so
 * shutdown can clear a timer that is still pending.
 */
/** addresses libp2p is confident enough in to have put behind `/sni/` */
function getConfirmedTlsAddresses(): string[] {
  if (!libp2p) {
    return []
  }
  return libp2p
    .getMultiaddrs()
    .filter((ma) => ma.toString().includes('/sni/'))
    .map((ma) => ma.toString())
}

/** the auto-tls event `detail` carries `{ key, cert, notAfter }` - see auto-tls.js */
function certificateExpiryFields(evt: any): Record<string, unknown> {
  const notAfter = evt?.detail?.notAfter
  return {
    expiresAt: notAfter instanceof Date ? notAfter.toISOString() : undefined
  }
}

function handleCertificateProvision(evt: any) {
  logEvent('info', 'tls:certificate-provisioned', certificateExpiryFields(evt))
  const timer = setTimeout(() => {
    certificateTimers.delete(timer)
    const tlsAddresses = getConfirmedTlsAddresses()
    logEvent('info', 'tls:addresses', {
      count: tlsAddresses.length,
      addresses: tlsAddresses
    })
  }, 1_000)
  timer.unref()
  certificateTimers.add(timer)
}

function handleCertificateRenew(evt: any) {
  logEvent('info', 'tls:certificate-renewed', certificateExpiryFields(evt))
}

/** stable fingerprint of everything the message actually carries */
function peerFingerprint(
  event: string,
  multiaddrs: string[],
  protocols: string[]
): string {
  return createHash('sha256')
    .update(JSON.stringify({ event, multiaddrs, protocols }))
    .digest('hex')
}

/**
 * genuinely LRU. `Map` iterates in insertion order but `set` on an
 * existing key does not reorder, so evicting `keys().next()` picked the entry
 * first *seen* - past the cap the victim was always the longest-lived, most
 * active peer, whose next update then re-published and evicted another. Deleting
 * before re-inserting moves the entry to the back, so the victim is the least
 * recently used one.
 */
function rememberFingerprint(peerId: string, fingerprint: string): void {
  peerFingerprints.delete(peerId)
  while (peerFingerprints.size >= FINGERPRINT_CACHE_SIZE) {
    const oldest = peerFingerprints.keys().next()
    if (oldest.done === true) {
      break
    }
    peerFingerprints.delete(oldest.value)
  }
  peerFingerprints.set(peerId, fingerprint)
}

/** a hit is activity, and `Map.get` does not reorder - refresh recency here */
function recallFingerprint(peerId: string): string | undefined {
  const fingerprint = peerFingerprints.get(peerId)
  if (fingerprint !== undefined) {
    peerFingerprints.delete(peerId)
    peerFingerprints.set(peerId, fingerprint)
  }
  return fingerprint
}

/**
 * `.sort` then `.slice` truncated lexicographically, which sheds
 * `/ip6` and `/p2p-circuit` before any `/ip4` - exactly the addresses a v6-only
 * or NAT'd peer is reachable on. Rank by usefulness instead: directly routable
 * addresses, then circuit-relay (the only route to the ~35% NAT'd fleet), then
 * private and loopback. Within a rank the address families are interleaved, so a
 * truncation cannot shed one family wholesale. Ordering stays deterministic,
 * which the fingerprint depends on.
 */
function multiaddrRank(addr: string): number {
  if (addr.includes('/p2p-circuit')) {
    return 1
  }
  const parts = addr.split('/')
  const host = parts.length > 2 ? parts[2] : undefined
  if (host === undefined || host === '') {
    return 2
  }
  if (!ipaddr.isValid(host)) {
    // a dns/dnsaddr name - assumed routable, which is the point of publishing it
    return 0
  }
  return ipaddr.parse(host).range() === 'unicast' ? 0 : 2
}

function multiaddrFamily(addr: string): string {
  const parts = addr.split('/')
  return parts.length > 1 ? parts[1] : ''
}

function prioritiseMultiaddrs(addresses: string[]): string[] {
  const sorted = [...addresses].sort()
  const out: string[] = []
  for (const rank of [0, 1, 2]) {
    const byFamily = new Map<string, string[]>()
    for (const addr of sorted) {
      if (multiaddrRank(addr) !== rank) {
        continue
      }
      const family = multiaddrFamily(addr)
      const bucket = byFamily.get(family)
      if (bucket === undefined) {
        byFamily.set(family, [addr])
      } else {
        bucket.push(addr)
      }
    }
    const families = [...byFamily.keys()].sort()
    for (let i = 0; ; i++) {
      let progressed = false
      for (const family of families) {
        const bucket = byFamily.get(family)
        if (bucket !== undefined && i < bucket.length) {
          out.push(bucket[i])
          progressed = true
        }
      }
      if (!progressed) {
        break
      }
    }
  }
  return out
}

/**
 * Two dedupe problems, both fixed here:
 *  1. the address list merged the event payload and a peerStore lookup with no
 *     dedup (and stringified `Address` objects rather than their multiaddr), so
 *     it is now built through a Set, sorted and bounded;
 *  2. it published on *every* `peer:update`, which also fires for tag-only
 *     changes - kad-dht re-tags its closest 20 peers every 5s - producing
 *     byte-identical messages. A peerId -> fingerprint map suppresses those, so
 *     feed volume tracks real address/protocol changes instead of routing-table
 *     churn.
 * Lookup failures are logged rather than silently swallowed.
 */
async function notifyQueue(
  event: string,
  peerId: string,
  addrs: any,
  protocols: string[] = []
): Promise<void> {
  const collected = new Set<string>()
  if (addrs) {
    for (const entry of addrs) {
      // `peer.addresses` holds `Address` objects, `peerInfo.multiaddrs` holds
      // multiaddrs - the old code stringified the former into '[object Object]'
      const value = entry?.multiaddr ?? entry
      if (value) {
        collected.add(value.toString())
      }
    }
  }
  if (libp2p) {
    try {
      const peerData = await libp2p.peerStore.get(peerIdFromString(peerId), {
        signal: AbortSignal.timeout(2000)
      })
      for (const address of peerData.addresses) {
        collected.add(address.multiaddr.toString())
      }
    } catch (e) {
      logEvent('debug', 'peerstore:lookup-failed', { peerId, ...errorFields(e) })
    }
  }

  // ranked, not lexicographic, so truncation drops the least useful
  const allMultiaddrs = prioritiseMultiaddrs([...collected])
  const multiaddrs = allMultiaddrs.slice(0, MAX_MULTIADDRS_PER_MESSAGE)
  const sortedProtocols = [...new Set(protocols.map(String))].sort()
  const fingerprint = peerFingerprint(event, multiaddrs, sortedProtocols)
  if (recallFingerprint(peerId) === fingerprint) {
    logEvent('debug', 'queue:skipped-unchanged', { peerId, peerEvent: event })
    return
  }

  const published = publishToQueue({
    peerId,
    event,
    timestamp: new Date().getTime(),
    multiaddrs,
    // the fingerprint covers `protocols`, so the payload carries them too -
    // otherwise a protocol-only change produced a byte-identical message. The
    // downstream consumer filters on protocols anyway.
    protocols: sortedProtocols
  })
  if (!published) {
    // no fingerprint recorded, so the next `peer:update` publishes this peer again
    return
  }
  rabbitmqPublished.add(1)
  rememberFingerprint(peerId, fingerprint)
  logEvent('debug', 'queue:published', {
    peerId,
    peerEvent: event,
    addressCount: multiaddrs.length,
    protocolCount: sortedProtocols.length,
    truncated: allMultiaddrs.length > multiaddrs.length
  })
}

/** the DHT service, loosely typed like the rest of `servicesConfig` */
function getDht(): any {
  return (libp2p as any)?.services?.dht
}

/** always `'server'` today - `clientMode: false` is unconditional on both roles */
function getDhtMode(): 'client' | 'server' | 'unknown' {
  const dht = getDht()
  if (!dht || typeof dht.getMode !== 'function') {
    return 'unknown'
  }
  return dht.getMode()
}

function getRoutingTableSize(): number {
  const size = getDht()?.routingTable?.size
  return typeof size === 'number' ? size : 0
}

/** logged on start and on every `self:peer:update`, and mirrored into /health and /ready */
function logDhtMode(trigger: string): void {
  const mode = getDhtMode()
  logEvent('info', 'dht:mode', {
    role: ROLE,
    mode,
    routingTableSize: getRoutingTableSize(),
    trigger
  })
}

function handlePeerConnect(details: any) {
  if (details) {
    const peerId = details.detail
    logEvent('debug', 'peer:connect', { peerId: peerId.toString() })
    p2pPeerConnect.add(1)
    // notifyQueue('connect', peerId.toString(), null)
  }
}
function handlePeerUpdate(evt: any) {
  if (evt) {
    const { peer } = evt.detail
    // `peer:update` also fires for tag-only changes, so this is debug rather
    // than an info-level line per kad-dht re-tag
    logEvent('debug', 'peer:update', {
      peerId: peer.id.toString(),
      protocols: peer.protocols
    })
    if (peer && peer.protocols && peer.protocols.includes('/ocean/nodes/1.0.0')) {
      notifyQueue('update', peer.id.toString(), peer.addresses, peer.protocols).catch(
        (e: unknown) => {
          logEvent('error', 'queue:notify-failed', {
            peerId: peer.id.toString(),
            ...errorFields(e)
          })
        }
      )
    }
  }
}

/** the *local* node's own record - new/changed listen addresses, protocols - as
 * opposed to `peer:update`, which fires for every other peer */
function handleSelfPeerUpdate(_evt: any): void {
  logDhtMode('self:peer:update')
}

function handlePeerDisconnect(details: any) {
  if (details) {
    const peerId = details.detail
    logEvent('debug', 'peer:disconnect', { peerId: peerId.toString() })
    p2pPeerDisconnect.add(1)
  }
}

function handlePeerDiscovery(details: any) {
  try {
    const peerInfo = details.detail
    logEvent('debug', 'peer:discovery', { peerId: peerInfo.id.toString() })
    p2pPeerDiscovery.add(1)

    if (!libp2p) return
    const currentConnections = libp2p.getConnections().length

    // the old gate was `currentConnections < minConnections ||
    // currentConnections < maxConnections`; with minConnections <= maxConnections
    // the first clause is always subsumed by the second, so this is all it ever
    // meant. (`minConnections` is also gone from libp2p v3's connectionManager.)
    if (currentConnections < P2P_CONFIG.maxConnections) {
      const existingConnections = libp2p.getConnections(peerInfo.id)
      if (existingConnections.length === 0) {
        libp2p
          .dial(peerInfo.id, {
            signal: AbortSignal.timeout(P2P_CONFIG.connectionsDialTimeout)
          })
          .catch((err: Error) => {
            logEvent('debug', 'dial:discovered-peer-failed', {
              peerId: peerInfo.id.toString(),
              ...errorFields(err)
            })
          })
      }
    }
    // we have no protocols here,so we don't queue
    // notifyQueue('discover', peerInfo.id.toString(), peerInfo.multiaddrs)
  } catch (e) {
    logEvent('warn', 'peer-discovery:handler-failed', errorFields(e))
  }
}

async function createNode(datastore: LevelDatastore): Promise<Libp2p | null> {
  try {
    const nodeKeys = getPeerIdFromPrivateKey(String(process.env.PRIVATE_KEY))

    // 9000/9001/9002/9003, replacing the privileged 1000-1003 range the
    // network never advertised. : `/ip6/::` rather than the `/ip6/::1`
    // loopback, which is what made every advertised /dns6/ address dead.
    const bindInterfaces = [
      `/ip4/${IPV4_BIND_ADDRESS}/tcp/${IPV4_TCP_PORT}`,
      `/ip4/${IPV4_BIND_ADDRESS}/tcp/${IPV4_WS_PORT}/ws`,
      `/ip6/${IPV6_BIND_ADDRESS}/tcp/${IPV6_TCP_PORT}`,
      `/ip6/${IPV6_BIND_ADDRESS}/tcp/${IPV6_WS_PORT}/ws`
    ]

    const announceAddresses = getAnnounceAddressesFromEnv()
    const filterAnnouncedAddresses = getFilterAnnouncedAddressesFromEnv()
    const announcePrivateIp = getAnnouncePrivateIpFromEnv()

    const announceFilter = (multiaddrs: any[]) =>
      multiaddrs.filter((m) =>
        shouldAnnounce(m, announcePrivateIp, filterAnnouncedAddresses)
      )

    let addresses: any
    if (announceAddresses.length > 0) {
      addresses = {
        listen: bindInterfaces,
        announceFilter,
        appendAnnounce: announceAddresses
      }
    } else {
      addresses = {
        listen: bindInterfaces,
        announceFilter
      }
    }

    // the bootstrap answers GET_PROVIDERS/FIND_NODE for the whole network, so any
    // private address it hands back is served to everyone asking - hygiene here is
    // network-wide, not local. `P2P_ANNOUNCE_PRIVATE=true` keeps the old
    // passthrough behaviour for a deployment that genuinely wants that (e.g. an
    // all-private test topology); `kBucketSize`, `clientMode` and the protocol
    // strings are unrelated invariants and stay exactly as they were.
    const peerInfoMapper = announcePrivateIp
      ? passthroughMapper
      : removePrivateAddressesMapper

    const dhtOptions = {
      allowQueryWithZeroPeers: false,
      // raised from 100/100 - a bootstrap is the fleet's DHT entry point
      maxInboundStreams: P2P_CONFIG.dhtMaxInboundStreams,
      maxOutboundStreams: P2P_CONFIG.dhtMaxOutboundStreams,
      // unconditional on both roles: a bootstrap and a relay are both publicly
      // reachable and must answer DHT queries, so there is deliberately no env
      // knob that could turn this into a client
      clientMode: false,
      kBucketSize: 20,
      protocol: '/ocean/nodes/1.0.0/kad/1.0.0',
      peerInfoMapper
    }

    let servicesConfig: any = {
      identify: identify(),
      identifyPush: identifyPush(),
      dht: kadDHT(dhtOptions),
      ping: ping(),
      dcutr: dcutr(),
      keychain: keychain(),
      http: http(),
      autoTLS: autoTLS({
        autoConfirmAddress: true
      })
    }

    // circuit-relay server on ON THE `relay` ROLE, never on `bootstrap` - this is
    // the ROLE matrix, not an independently settable env knob, precisely so the
    // two cannot drift apart
    if (ROLE === 'relay') {
      servicesConfig = {
        ...servicesConfig,
        circuitRelay: circuitRelayServer({
          reservations: { maxReservations: RELAY_MAX_RESERVATIONS }
        })
      }
    }

    const transports = [webSockets(), tcp(), circuitRelayTransport()]

    // mDNS finds nothing across cloud regions, so it is off unless
    // explicitly enabled for a local or test topology
    const peerDiscovery: any[] = []
    if (P2P_CONFIG.enableMDNS) {
      logEvent('info', 'mdns:enabled', { intervalMs: P2P_CONFIG.mDNSInterval })
      peerDiscovery.push(mdns({ interval: P2P_CONFIG.mDNSInterval }))
    } else {
      logEvent('info', 'mdns:disabled')
    }

    // mDNS finds nothing cross-region; this is what actually forms a mesh between
    // bootstraps in different regions/clouds. Env-supplied only - no hardcoded
    // fallback list here, see BOOTSTRAP_SEED_KEEP_ALIVE_TAG for why the tag name
    // matters as much as the list itself.
    const bootstrapPeers = getBootstrapPeersFromEnv()
    if (bootstrapPeers.length > 0) {
      logEvent('info', 'seed-mesh:enabled', { peerCount: bootstrapPeers.length })
      peerDiscovery.push(
        bootstrap({
          list: bootstrapPeers,
          tagName: BOOTSTRAP_SEED_KEEP_ALIVE_TAG,
          tagValue: BOOTSTRAP_SEED_TAG_VALUE
          // no tagTTL: this tag must never expire, or the reconnect queue drops
          // these peers off its watch list the moment the default TTL lapses
        })
      )
    } else {
      logEvent('warn', 'seed-mesh:disabled', {
        reason:
          'BOOTSTRAP_PEERS not set - this node will not proactively mesh with its peers, and will only learn about them from inbound dials'
      })
    }

    const options: any = {
      addresses,
      privateKey: nodeKeys.privateKey,
      transports,
      streamMuxers: [yamux()],
      connectionEncrypters: [noise(), tls()],
      services: servicesConfig,
      datastore,
      connectionManager: {
        maxParallelDials: P2P_CONFIG.connectionsMaxParallelDials,
        dialTimeout: P2P_CONFIG.connectionsDialTimeout,
        maxConnections: P2P_CONFIG.maxConnections,
        maxPeerAddrsToDial: P2P_CONFIG.maxPeerAddrsToDial,
        maxDialQueueLength: P2P_CONFIG.maxDialQueueLength,
        // without these two `maxConnections` is unreachable - see the constants
        maxIncomingPendingConnections: MAX_INCOMING_PENDING_CONNECTIONS,
        inboundConnectionThreshold: INBOUND_CONNECTION_THRESHOLD
      },
      connectionMonitor: {
        abortConnectionOnPingFailure: false
      },
      peerStore: {
        maxAddressAge: PEER_STORE_MAX_AGE_MS,
        maxPeerAge: PEER_STORE_MAX_AGE_MS
      },
      peerDiscovery
    }

    const node = await createLibp2p(options)
    await node.start()

    logEvent('info', 'p2p:started', { role: ROLE, peerId: nodeKeys.peerId.toString() })
    return node
  } catch (e) {
    logEvent('error', 'p2p:start-failed', errorFields(e))
  }
  return null
}

function hexStringToByteArray(hexString: string) {
  const hex = hexString.startsWith('0x') ? hexString.slice(2) : hexString
  if (hex.length % 2 !== 0) {
    throw new Error('Must have an even number of hex digits to convert to bytes')
  }
  const numBytes = hex.length / 2
  const byteArray = new Uint8Array(numBytes)
  for (let i = 0; i < numBytes; i++) {
    byteArray[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return byteArray
}

function getPeerIdFromPrivateKey(privateKey: string): OceanNodeKeys {
  const privateKeyHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
  const privateKeyBytes = hexStringToByteArray(privateKeyHex)
  const key = privateKeyFromRaw(privateKeyBytes)

  return {
    peerId: peerIdFromPrivateKey(key),
    publicKey: key.publicKey.raw,
    privateKey: key
  }
}

/**
 * A backstop for reporting, not for surviving. It logs one structured line with
 * the stack and exits non-zero, so an unexpected failure lands in the same
 * JSON-lines feed as everything else instead of a bare stderr dump.
 *
 * It deliberately does not decide that some errors are survivable. It used to
 * match on `e.code` alone, which meant *any* uncaught transport-coded error from
 * *any* subsystem was swallowed and reported as a RabbitMQ problem: this process
 * runs a full libp2p node, so a `/dnsaddr` lookup answering `ENOTFOUND`, a peer
 * dial answering `ECONNREFUSED`, and a muxer read answering `ECONNRESET` are all
 * routine, and so is an un-awaited dial rejecting - which node turns into an
 * uncaught exception by default. All of them were absorbed, logged with no stack,
 * and captioned with an explanation blaming a library that had nothing to do with
 * them, which sent triage in the wrong direction. The one error that genuinely
 * had to be survived is now handled where it originates, by the listener the
 * recovery `setup` hook installs on the model.
 */
process.on('uncaughtException', (e: Error) => {
  logEvent('error', 'process:uncaught-exception', {
    ...errorFields(e),
    stack: e?.stack
  })
  process.exit(1)
})

// Registered before start so a signal during
// startup is still handled. These are inert until the Dockerfile adds an init
// (`dumb-init` / `--init`): Node as PID 1 never receives SIGTERM from
// `docker stop`, which exits 137 today.
process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((e: unknown) => {
    logEvent('error', 'shutdown:failed', { signal: 'SIGTERM', ...errorFields(e) })
    process.exit(1)
  })
})
process.on('SIGINT', () => {
  shutdown('SIGINT').catch((e: unknown) => {
    logEvent('error', 'shutdown:failed', { signal: 'SIGINT', ...errorFields(e) })
    process.exit(1)
  })
})

await start()
