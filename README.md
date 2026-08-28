# ocean-node-bootstrap

Ocean Node bootstrap peer: a long-lived libp2p node that other Ocean nodes dial to
join the network (bootstrap list, DHT server, and - on `ROLE=relay` - circuit-relay
server), and which optionally publishes peer updates to RabbitMQ.

## Configuration

| Env var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PRIVATE_KEY` | **yes** | — | node key; determines the peer ID other nodes have in their bootstrap list |
| `ROLE` | no | `bootstrap` | `bootstrap` or `relay` - see "Role" below. An unrecognised value is fatal at startup |
| `RABBITMQ_URL` | no | unset | when set **and** `ROLE=bootstrap`, peer updates are published to RabbitMQ. Never started on `ROLE=relay` |
| `BOOTSTRAP_PEERS` | no | unset | comma-separated multiaddrs of the other bootstraps to seed-mesh with - see "Seed mesh" below |
| `P2P_MAX_CONNECTIONS` | no | `5000` (`bootstrap`) / `100` (`relay`) | connection-manager ceiling. **Drives the `nofile` requirement below** |
| `P2P_DATASTORE_PATH` | no | `./databases/bootstrap-store` | on-disk path for the persistent datastore - see "Persistent datastore" below |
| `P2P_ADMIN_PORT` | no | `9100` | port for `/health` and `/ready` - see "Health and readiness" below |
| `P2P_READY_MIN_ROUTING_TABLE_PEERS` | no | `1` | minimum DHT routing-table size for `/ready` to report ready |
| `P2P_ANNOUNCE_PRIVATE` | no | `false` | when `true`, the DHT stops filtering private addresses out of `FIND_NODE`/`GET_PROVIDERS` responses - see "Private-address hygiene" below |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | unset | OTLP/HTTP base endpoint of an OpenTelemetry collector (e.g. `http://otel-collector:4318`). **Setting it is what turns telemetry on** - see "Metrics" below |
| `TELEMETRY_ENABLED` | no | unset | master switch; set to `off` to force telemetry off even when an endpoint is configured. Any other value (or unset) leaves it on when an endpoint is set |
| `OTEL_METRIC_EXPORT_INTERVAL` | no | `60000` | metric push interval in ms |
| `OTEL_SERVICE_NAME` | no | `ocean-node-bootstrap` | overrides the `service.name` resource attribute |
| `DEPLOYMENT_ENVIRONMENT` | no | `NODE_ENV` or `development` | `deployment.environment` resource attribute |
| `OCEAN_NETWORK_LABEL` | no | unset | optional `ocean.network` resource attribute, to group fleets in a central collector |

The remaining `P2P_*` connection-manager knobs (`P2P_connectionsMaxParallelDials`,
`P2P_connectionsDialTimeout`, `P2P_MAXPEERADDRSTODIAL`,
`P2P_MAX_DIAL_QUEUE_LENGTH`, `P2P_dhtMaxInboundStreams`,
`P2P_dhtMaxOutboundStreams`, `P2P_ENABLE_MDNS`, `P2P_mDNSInterval`,
`P2P_SHUTDOWN_TIMEOUT_MS`) are env-driven with the defaults in `src/index.ts`, so a
bootstrap can be retuned without a rebuild. The listen ports (9000-9003) are
deliberately **not** configurable: they have to match what the fleet dials.

## Role

`ROLE` locks a whole matrix of behaviour together so a deployment cannot drift into
an invalid combination - e.g. a node running both the circuit-relay server and the
RabbitMQ discovery feed. Default is `bootstrap`, so an unset `ROLE` never
accidentally turns a node into a relay.

| Knob | `ROLE=bootstrap` | `ROLE=relay` |
| --- | --- | --- |
| circuit-relay server | off | **on** |
| RabbitMQ discovery feed | on (if `RABBITMQ_URL` set) | **never started** |
| listed in other nodes' `BOOTSTRAP_PEERS` | yes | **no** (operational convention - not enforced here) |
| DHT mode | server | server (unconditional on both; no env override exists) |
| `maxConnections` default | `5000` | `100` (sized to the relay reservation limit) |
| persistent datastore, announce filtering, graceful shutdown | yes | yes |
| autoTLS | yes | **yes** - a relay must be TLS-reachable or browsers cannot traverse it |

pubsub/gossipsub/floodsub are never enabled on either role - that caused
network-wide outages previously and stays permanently off.

## Persistent datastore

`P2P_DATASTORE_PATH` (default `./databases/bootstrap-store`, relative to the
process CWD) is opened as a `LevelDatastore` and passed to `createLibp2p`. **The
Dockerfile declares a `VOLUME` at `/usr/src/app/databases` and this must be backed
by a persistent mount in production** - a named volume, a bind mount, or the
Kubernetes-equivalent persistent volume claim. Without it the datastore still
works, it just starts empty on every restart, which defeats the point of this
section.

Two independent things depend on this:

- **autoTLS certificate persistence.** Without a persistent datastore, autoTLS
  re-runs the full ACME flow against Let's Encrypt on every restart, which risks
  hitting a rate limit and leaves the node with no TLS address at all until it
  clears. Startup logs `datastore:open` with `tlsCertificate:
  "loaded-from-disk"` or `"not-found-will-provision"`, and `tls:certificate-provisioned`
  / `tls:certificate-renewed` carry the certificate's `expiresAt`.
- **The peer-store address TTL.** The 48 h peer/address lifetime the connection
  manager already carries only matters if the peer store itself survives a
  restart - a `MemoryDatastore` (the libp2p default when nothing is passed) is
  gone the moment the process exits, TTL or not.

```bash
docker run -d \
  --ulimit nofile=65536:65536 \
  -e PRIVATE_KEY="$PRIVATE_KEY" \
  -v ocean-bootstrap-data:/usr/src/app/databases \
  -p 9000-9003:9000-9003 \
  oceanprotocol/ocean-node-bootstrap
```

## Seed mesh

mDNS finds nothing across cloud regions, so bootstraps in different
regions/providers only ever learn about each other from inbound dials - they never
proactively mesh. `BOOTSTRAP_PEERS` (comma-separated multiaddrs, each ending
`/p2p/<peerId>`) adds `@libp2p/bootstrap` peer discovery with those addresses,
tagged `keep-alive-bootstrap-seed` rather than the library's default `bootstrap`
tag - libp2p's connection manager only actively redials a peer whose tag name
*starts with* `keep-alive`; the plain `bootstrap` tag merely protects a peer from
being trimmed, it never triggers a reconnect. The tag carries no TTL, so it never
expires and the reconnect keeps applying for the life of the process.

`BOOTSTRAP_PEERS` is **env-supplied only** - there is deliberately no hardcoded
fallback list in this repo. The canonical list already lives in two other repos;
a third copy here would only be one more place for it to drift out of sync. If
`BOOTSTRAP_PEERS` is unset, startup logs a `seed-mesh:disabled` warning rather than
silently falling back to anything.

```bash
docker run -d \
  -e PRIVATE_KEY="$PRIVATE_KEY" \
  -e BOOTSTRAP_PEERS="/dns4/bootstrap-2.example.com/tcp/9000/p2p/12D3Koo...,/dns4/bootstrap-3.example.com/tcp/9000/p2p/12D3Koo..." \
  oceanprotocol/ocean-node-bootstrap
```

## Health and readiness

`GET /health` and `GET /ready` are served on a **separate admin HTTP server**, bound
to `127.0.0.1:9100` by default (`P2P_ADMIN_PORT` changes the port; the host is
deliberately not configurable).

**Why loopback-only:** neither endpoint carries authentication, so the bind address
is the only thing standing between them and the public internet. A process bound to
`127.0.0.1` inside a container's network namespace cannot be reached through that
container's external interface, even via `docker run -p` - so this is a deliberate
choice to make it impossible for an operator to expose them by simply publishing a
port, at the cost of that same port not being directly reachable from outside the
container. Reach it with:

```bash
# one-shot check from the host. The runtime image is slim: it has no wget, curl,
# busybox or nc, so use the node binary that is already there.
docker exec <container> node -e \
  "fetch('http://127.0.0.1:9100/health').then(r=>r.text()).then(t=>console.log(t))"
```

or a reverse proxy running inside the same network namespace if you need
authenticated external access.

- **`/health`** - liveness. 200 once libp2p has been created and is not stopping/
  stopped; 503 otherwise. Body includes `role`, `libp2pStatus`, `dhtMode`, `peerId`,
  `uptimeSec`.
- **`/ready`** - readiness. 200 only when *all* of: libp2p status is `started`; at
  least one confirmed public/TLS (`/sni/`) listen address exists; the DHT is in
  server mode; the DHT routing table holds at least `P2P_READY_MIN_ROUTING_TABLE_PEERS`
  peers (default `1`). 503 otherwise, with a `checks` object showing which
  condition(s) failed.

## Metrics

Metrics are exported over **OpenTelemetry**, **push-only**: the process pushes OTLP/HTTP to
an OpenTelemetry collector at `OTEL_EXPORTER_OTLP_ENDPOINT`, which fans out to Prometheus
(metrics) and Tempo (traces) for Grafana. There is **no `/metrics` scrape endpoint** - the
admin server stays loopback-only `/health` + `/ready`, and this push model is exactly what
lets a loopback-bound process still be observed. Telemetry is a **hard no-op** until
`OTEL_EXPORTER_OTLP_ENDPOINT` is set (and `TELEMETRY_ENABLED` is not `off`): an unconfigured
node emits nothing and its behaviour is unchanged.

The SDK is loaded via `node --import ./dist/telemetry/otel.js` (already in the `start` script
and the Dockerfile `CMD`), before `dist/index.js`. Each process stamps a resource identity:
`service.name` (`ocean-node-bootstrap`), `service.version`, `deployment.environment`,
`ocean.node.role` (`bootstrap`/`relay` from `ROLE`), optional `ocean.network`, and
`service.instance.id` = the node's **libp2p peerId** (derived from `PRIVATE_KEY`; a random
UUID if the key is missing). Instance identity lives on the resource, never as a metric
label - metric labels are bounded enums only (no peerId / multiaddr / IP).

Instruments emitted (OTel dotted names; Prometheus mangles dots to `_` and appends `_total`
to counters):

- Counters: `ocean.p2p.peer.connect`, `ocean.p2p.peer.disconnect`, `ocean.p2p.peer.discovery`,
  and `ocean.bootstrap.rabbitmq.published` (peer-update messages accepted by the RabbitMQ
  discovery feed, `ROLE=bootstrap` only).
- Observable gauges: `ocean.p2p.connections` (labels `direction`, `limited`),
  `ocean.p2p.dht.routing_table_peers`, `ocean.p2p.dht.mode` (`1` = server, `0` = client -
  this restores the removed `ocean_bootstrap_dht_mode`), `ocean.p2p.relay_reservations`, and
  `ocean.p2p.dial_queue` (label `status`).
- Plus Node runtime metrics (`@opentelemetry/instrumentation-runtime-node`: V8 heap,
  event-loop delay, GC) and host/process metrics (`@opentelemetry/host-metrics`).

A ready-to-run collector + Prometheus + Tempo + Grafana stack lives in the ocean-node repo
under `deploy/telemetry/`; point `OTEL_EXPORTER_OTLP_ENDPOINT` at that collector.

## Private-address hygiene

The DHT's `peerInfoMapper` is `removePrivateAddressesMapper` by default, not the
previous unconditional `passthroughMapper`. This is the highest-leverage hygiene
point in the network: a bootstrap answers `GET_PROVIDERS` and `FIND_NODE` **for
the whole network**, so any private/loopback address it holds in its routing table
is served to every peer that asks, not just used locally. Set
`P2P_ANNOUNCE_PRIVATE=true` to restore the old unconditional-passthrough behaviour
(e.g. for an all-private test topology) - the same env var that already controlled
whether this node announces its *own* private addresses now also controls what it
hands back for *other* peers.

`kBucketSize`, `clientMode` and the DHT protocol strings are unrelated invariants
and are unaffected by this - they stay exactly as they were.

## Required OS file-descriptor limit (`nofile`)

**This is a deploy requirement, not a build-time one. It cannot be set from the
`Dockerfile` — the container's `nofile` limit comes from the container runtime, so
it has to be set on every `docker run` / compose service / node runtime. If you
skip it you will get `EMFILE` failures under load with nothing else obviously
wrong.**

Every established libp2p connection costs at least one file descriptor, on top of
the listeners, the AMQP socket and DNS sockets. With the default
`P2P_MAX_CONNECTIONS=5000`, a host default of `nofile=1024` means the node starts
fine, serves ~1000 peers, and then begins failing accepts and dials with `EMFILE:
too many open files` while the connection manager still believes it has 4000 slots
free.

### The threshold

```
required nofile hard limit  >=  P2P_MAX_CONNECTIONS * 1.2
```

**The requirement is on the _hard_ limit, not the soft one.** Node raises its own
`nofile` soft limit to the hard limit during startup, so whatever soft value the
runtime hands the container is irrelevant to the node process — the hard limit is
its real ceiling. Measured on this image: with `--ulimit nofile=1024:65536` the
node process reports `soft 65536` and the startup line is `info`; with `--ulimit
nofile=1024:2048` it reports `soft 2048` and the warning fires. The soft value was
`1024` in both cases, so only the hard value moved the outcome. Set both anyway
(the recipes below do): the soft value costs nothing, and it keeps the limit
correct for anything in the container that does not self-raise.

| `P2P_MAX_CONNECTIONS` | minimum hard `nofile` | recommended `nofile` (soft:hard) |
| --- | --- | --- |
| `5000` (default) | **6000** | **65536:65536** |
| `10000` | 12000 | 65536:65536 |

The `1.2` factor is the headroom for the non-connection descriptors listed above.
`65536` is the recommended value to actually deploy: it clears the default with
room to grow, and it is well inside what a normal Linux host allows. The process
**warns at startup** when the effective limit it observes is below
`P2P_MAX_CONNECTIONS * 1.2`, so a misconfigured runtime is visible in the logs
instead of silent — that warning uses this exact threshold, and because of the
self-raise it is in practice a check on the hard limit.

### Setting it

**`docker run`**

```bash
docker run -d \
  --ulimit nofile=65536:65536 \
  -e PRIVATE_KEY="$PRIVATE_KEY" \
  -p 9000-9003:9000-9003 \
  oceanprotocol/ocean-node-bootstrap
```

**Docker Compose** (`docker-compose.yml`)

```yaml
services:
  bootstrap:
    image: oceanprotocol/ocean-node-bootstrap
    environment:
      PRIVATE_KEY: ${PRIVATE_KEY}
    ports:
      - '9000-9003:9000-9003'
    ulimits:
      nofile:
        soft: 65536
        hard: 65536
```

**Docker daemon default** (applies to every container on the host, useful when the
run command is not under your control):

In `/etc/docker/daemon.json` (strict JSON - the daemon rejects comments), then
`systemctl restart docker`:

```json
{
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Soft": 65536, "Hard": 65536 }
  }
}
```

**Kubernetes.** There is no pod- or container-level `ulimit` field in the Pod
spec, so this must be set on the node's container runtime and the pods inherit
it. For containerd or CRI-O, set it in the runtime's systemd unit (via a drop-in,
e.g. `/etc/systemd/system/containerd.service.d/nofile.conf`) and restart the
runtime:

```ini
[Service]
LimitNOFILE=65536
```

Then verify from inside a scheduled pod (see below) — do not assume the cluster
default is high enough. Managed node images vary: some ship `LimitNOFILE=infinity`
on the runtime and need nothing, others ship `1024`.

**systemd, running the node directly (no container):**

```ini
# /etc/systemd/system/ocean-node-bootstrap.service
[Service]
LimitNOFILE=65536
```

### Verifying

Read the limits of the **node process**, not of PID 1. PID 1 is `dumb-init`, which
does not self-raise, so its soft column keeps showing whatever the runtime set and
will read low — `1024` — on a completely correct deploy. Only its _hard_ column is
meaningful. Checking `/proc/1/limits` and reading the soft value is how a healthy
bootstrap gets misdiagnosed as broken.

The startup log line is the authoritative check, because the process reports the
limit it is actually running under:

```bash
docker logs <container> | grep 'ulimit:nofile'
# ok:  {"level":"info","event":"ulimit:nofile","soft":65536,"required":6000,...}
# bad: {"level":"warn","event":"ulimit:nofile-too-low","soft":2048,"required":6000,...}
```

To read it from `/proc` instead: the runtime image ships no `ps`, `pgrep` or
`pidof`, and the node process is `dumb-init`'s only child, so take it from PID 1's
child list:

```bash
docker exec <container> sh -c \
  'for p in $(cat /proc/1/task/1/children); do grep "Max open files" /proc/$p/limits; done'
# -> Max open files            65536                65536                files

kubectl exec <pod> -- sh -c \
  'for p in $(cat /proc/1/task/1/children); do grep "Max open files" /proc/$p/limits; done'
```

Note that `docker exec` gets its own rlimits from the container configuration, not
from the node process, so `docker exec <container> sh -c 'ulimit -n'` reports the
soft value the runtime set and not the limit the node is using. It is only useful
before deploying, to confirm what the runtime will grant:

```bash
docker run --rm --ulimit nofile=65536:65536 oceanprotocol/ocean-node-bootstrap \
  sh -c 'echo "soft=$(ulimit -Sn) hard=$(ulimit -Hn)"'   # -> soft=65536 hard=65536
```

## Development

```bash
npm ci
npm run build        # clean + tsc
npm run type-check
npm run lint
npm test
docker build -t ocean-node-bootstrap .
```
