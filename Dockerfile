FROM node:24.19.0-trixie@sha256:66bb8d36ae1ddd72199ed235a089904874ca4079ee517936ca3adb80506a75c1 AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    libatomic1 \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev


FROM node:24.19.0-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS runner
# dumb-init is the same init ocean-node's runner installs. Without an init, node is
# PID 1: it never receives SIGTERM from `docker stop`, so the stop waits out the
# full grace period and the container exits 137. dumb-init forwards the signal.
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    libatomic1 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY --chown=node:node --from=builder /usr/src/app/dist ./dist
COPY --chown=node:node --from=builder /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=builder /usr/src/app/package.json ./

# the --chown on the COPYs above was cosmetic while the process still ran as root.
# WORKDIR is created root-owned, so hand it to node as well, keeping the working
# directory writable for the unprivileged user.
RUN chown node:node /usr/src/app

# P2P_DATASTORE_PATH default (./databases/bootstrap-store, resolved against
# WORKDIR). Pre-created and chowned here so the unprivileged `node` user below can
# open it; VOLUME declares the mount point so a named volume or bind mount can be
# attached at `docker run` time. This directory is REQUIRED to be a persistent
# mount, not just documented as one: without it, autoTLS re-runs the ACME flow on
# every restart (risking a Let's Encrypt rate limit that leaves the node with no
# TLS address at all) and the 48 h peer/address TTL is wiped every restart, both
# because the datastore is otherwise gone the moment the container is. See
# "Persistent datastore" in README.md.
RUN mkdir -p /usr/src/app/databases/bootstrap-store \
    && chown -R node:node /usr/src/app/databases
VOLUME ["/usr/src/app/databases"]

# ocean-node drops privileges with gosu from its docker-entrypoint.sh; that script
# is deliberately not copied here, so the drop is done statically instead.
USER node

# The container's `nofile` limit is set by the container *runtime*, not by
# the image - a `RUN ulimit -n` here would only change that build step, and there
# is no Dockerfile instruction that raises the limit of the eventual container. So
# the requirement is recorded rather than enforced: every deploy must grant a
# *hard* `nofile` of at least `P2P_MAX_CONNECTIONS * 1.2` (6000 at the default
# maxConnections of 5000; deploy 65536). The hard limit is the binding one because
# node raises its own soft limit to the hard limit at startup - dumb-init does not,
# so PID 1's soft column is not the number to read. Without the headroom the node
# hits `EMFILE` at roughly the host default (often 1024) while the connection
# manager still believes it has thousands of slots free. See "Required OS
# file-descriptor limit" in README.md for the per-platform recipes (docker run /
# compose / daemon defaults / Kubernetes runtime / systemd), for how to verify it
# against the node process rather than PID 1, and `docker run --ulimit
# nofile=65536:65536` for the short version. The process itself warns at startup
# when the limit it is effectively running under is below that threshold.
LABEL io.oceanprotocol.bootstrap.nofile-minimum="hard limit >= P2P_MAX_CONNECTIONS * 1.2 (6000 at the default 5000)" \
      io.oceanprotocol.bootstrap.nofile-recommended="65536:65536" \
      io.oceanprotocol.bootstrap.nofile-howto="--ulimit nofile=65536:65536 (docker run), ulimits.nofile (compose), LimitNOFILE on the node container runtime (kubernetes); see README.md"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--import", "./dist/telemetry/otel.js", "--max-old-space-size=28784", "--trace-warnings", "--experimental-specifier-resolution=node", "dist/index.js"]
