/**
 * The bootstrap is one module that starts a libp2p node and a RabbitMQ connection at
 * import time (`await start()` on its last line), and it exports nothing. To unit-test
 * the pure functions inside it, this loads the real source with that one call removed
 * and an explicit export block appended, then imports the result. Nothing is rewritten:
 * the function bodies under test are the shipped ones, byte for byte.
 *
 * Every anchor it edits is asserted, so if the source moves under it this fails loudly
 * instead of quietly testing something that is no longer there.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, '..', 'src', 'index.ts')
const harnessDir = join(here, '.harness')

const START_CALL = '\nawait start()'

/** Module-level bindings the tests need to read or stand in for. */
const EXPORTS = `
export const internals = {
  notifyQueue,
  publishToQueue,
  peerFingerprint,
  rememberFingerprint,
  recallFingerprint,
  peerFingerprints,
  prioritiseMultiaddrs,
  multiaddrRank,
  multiaddrFamily,
  envNumber,
  envBoolean,
  envString,
  handlePeerUpdate,
  MAX_MULTIADDRS_PER_MESSAGE,
  FINGERPRINT_CACHE_SIZE,
  RABBITMQ_QUEUE,
  setRabbitChannel(channel) {
    rabbitChannel = channel
  },
  setLibp2p(node) {
    libp2p = node
  }
}
`

let loaded

/** Imports the bootstrap module with its top-level start-up call removed. */
export async function loadBootstrapInternals() {
  if (loaded) return loaded
  const source = await readFile(sourcePath, 'utf8')
  const occurrences = source.split(START_CALL).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one top-level start() call in src/index.ts, found ${occurrences}`
    )
  }
  for (const name of [
    'function notifyQueue',
    'function prioritiseMultiaddrs',
    'let rabbitChannel'
  ]) {
    if (!source.includes(name)) {
      throw new Error(`src/index.ts no longer contains "${name}" - update this harness`)
    }
  }
  // `Libp2p` is only ever used in type positions, but it is imported alongside a value,
  // so Node's type stripping leaves it in the import list and the real module has no
  // such runtime export. Dropping the name is enough: every use of it is erased anyway.
  const TYPE_IMPORT = "import { createLibp2p, Libp2p } from 'libp2p'"
  if (!source.includes(TYPE_IMPORT)) {
    throw new Error('src/index.ts libp2p import changed shape - update this harness')
  }
  const rewritten =
    source
      .replace(TYPE_IMPORT, "import { createLibp2p } from 'libp2p'")
      .replace(START_CALL, '\n// start() suppressed') + EXPORTS
  await mkdir(harnessDir, { recursive: true })
  const target = join(harnessDir, 'bootstrap.harness.mts')
  await writeFile(target, rewritten, 'utf8')
  const module = await import(pathToFileURL(target).href)
  loaded = module.internals
  return loaded
}

export async function cleanupHarness() {
  await rm(harnessDir, { recursive: true, force: true })
}

/** Collects everything the module publishes instead of handing it to a broker. */
export function captureQueue(internals) {
  const published = []
  internals.setRabbitChannel({
    sendToQueue(queue, buffer) {
      published.push({ queue, payload: JSON.parse(buffer.toString('utf8')) })
      return true
    }
  })
  return published
}
