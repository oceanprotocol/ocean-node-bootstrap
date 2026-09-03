import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { multiaddr } from '@multiformats/multiaddr'
import { captureQueue, cleanupHarness, loadBootstrapInternals } from './harness.mjs'

let internals
let published

before(async () => {
  internals = await loadBootstrapInternals()
  internals.setLibp2p(null)
  // `logEvent` writes a JSON line per call; the debug ones are pure noise here.
  console.debug = () => {}
})
after(async () => {
  await cleanupHarness()
})
beforeEach(() => {
  internals.peerFingerprints.clear()
  published = captureQueue(internals)
})

const PEER = '16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP'

/** The shape libp2p's `peer.addresses` really has: an `Address` wrapper, not a multiaddr. */
function addressObjects(...values) {
  return values.map((value) => ({ multiaddr: multiaddr(value), isCertified: false }))
}
/** The shape `peerInfo.multiaddrs` really has: multiaddrs themselves. */
function multiaddrObjects(...values) {
  return values.map((value) => multiaddr(value))
}

const OCEAN_PROTOCOL = '/ocean/nodes/1.0.0'

test('an Address wrapper is published as its multiaddr, never as "[object Object]"', async () => {
  // `peer.addresses` holds `Address` objects. Stringifying one of those directly is
  // the defect: every address in the feed became the literal text "[object Object]".
  await internals.notifyQueue(
    'update',
    PEER,
    addressObjects('/ip4/1.2.3.4/tcp/9000', '/ip4/1.2.3.4/tcp/9001/ws'),
    [OCEAN_PROTOCOL]
  )
  assert.equal(published.length, 1)
  assert.deepEqual(published[0].payload.multiaddrs, [
    '/ip4/1.2.3.4/tcp/9000',
    '/ip4/1.2.3.4/tcp/9001/ws'
  ])
})

test('no input shape can put "[object Object]" into the published addresses', async () => {
  const shapes = {
    'Address wrappers': addressObjects('/ip4/1.2.3.4/tcp/9000'),
    'bare multiaddrs': multiaddrObjects('/ip4/5.6.7.8/tcp/9000'),
    'plain strings': ['/ip4/9.10.11.12/tcp/9000'],
    'mixed wrappers and multiaddrs': [
      ...addressObjects('/ip4/1.2.3.4/tcp/9000'),
      ...multiaddrObjects('/ip6/2606:4700::1/tcp/9000')
    ],
    'wrapper whose multiaddr is a string': [{ multiaddr: '/ip4/13.14.15.16/tcp/9000' }]
  }
  for (const [name, addrs] of Object.entries(shapes)) {
    internals.peerFingerprints.clear()
    published.length = 0
    await internals.notifyQueue('update', PEER, addrs, [OCEAN_PROTOCOL])
    assert.equal(published.length, 1, `${name} published nothing`)
    const { multiaddrs } = published[0].payload
    assert.ok(multiaddrs.length > 0, `${name} published no addresses`)
    for (const value of multiaddrs) {
      assert.equal(typeof value, 'string', `${name}: ${value} is not a string`)
      assert.ok(
        !value.includes('[object Object]'),
        `${name} published the stringified object "${value}"`
      )
      // The real proof that it is an address and not just "not [object Object]".
      assert.doesNotThrow(() => multiaddr(value), `${name}: ${value} is not a multiaddr`)
    }
  }
})

test('empty and unusable address entries are dropped rather than stringified', async () => {
  await internals.notifyQueue(
    'update',
    PEER,
    [null, undefined, ...addressObjects('/ip4/1.2.3.4/tcp/9000')],
    [OCEAN_PROTOCOL]
  )
  assert.deepEqual(published[0].payload.multiaddrs, ['/ip4/1.2.3.4/tcp/9000'])
})

test('the published message carries peerId, event, timestamp, multiaddrs and protocols', async () => {
  const before = Date.now()
  await internals.notifyQueue('update', PEER, addressObjects('/ip4/1.2.3.4/tcp/9000'), [
    OCEAN_PROTOCOL,
    '/ipfs/ping/1.0.0'
  ])
  const { payload, queue } = published[0]
  assert.equal(queue, internals.RABBITMQ_QUEUE)
  assert.deepEqual(Object.keys(payload).sort(), [
    'event',
    'multiaddrs',
    'peerId',
    'protocols',
    'timestamp'
  ])
  assert.equal(payload.peerId, PEER)
  assert.equal(payload.event, 'update')
  assert.ok(payload.timestamp >= before && payload.timestamp <= Date.now())
  // sorted and de-duplicated, so the fingerprint over them is stable
  assert.deepEqual(payload.protocols, ['/ipfs/ping/1.0.0', OCEAN_PROTOCOL])
})

test('a protocol-only change still produces a different message', async () => {
  const addrs = addressObjects('/ip4/1.2.3.4/tcp/9000')
  await internals.notifyQueue('update', PEER, addrs, [OCEAN_PROTOCOL])
  await internals.notifyQueue('update', PEER, addrs, [OCEAN_PROTOCOL, '/ipfs/id/1.0.0'])
  assert.equal(published.length, 2, 'the protocol change was suppressed as a duplicate')
  assert.notDeepEqual(published[0].payload.protocols, published[1].payload.protocols)
})

test('an identical repeat is suppressed and a changed address is not', async () => {
  const addrs = addressObjects('/ip4/1.2.3.4/tcp/9000')
  await internals.notifyQueue('update', PEER, addrs, [OCEAN_PROTOCOL])
  await internals.notifyQueue('update', PEER, addrs, [OCEAN_PROTOCOL])
  await internals.notifyQueue('update', PEER, addrs, [OCEAN_PROTOCOL])
  assert.equal(published.length, 1, 'byte-identical repeats must not reach the queue')

  await internals.notifyQueue(
    'update',
    PEER,
    addressObjects('/ip4/1.2.3.4/tcp/9000', '/ip4/1.2.3.4/tcp/9001/ws'),
    [OCEAN_PROTOCOL]
  )
  assert.equal(published.length, 2, 'a new address must be published')
})

test('a message that never reached the broker is retried on the next update', async () => {
  // A thrown channel/connection error is the real "not delivered" case: amqplib
  // rejects the publish outright, so nothing is queued and it must be resent.
  internals.setRabbitChannel({
    sendToQueue() {
      throw new Error('channel closed')
    }
  })
  const addrs = addressObjects('/ip4/1.2.3.4/tcp/9000')
  await internals.notifyQueue('update', PEER, addrs, [OCEAN_PROTOCOL])
  published = captureQueue(internals)
  await internals.notifyQueue('update', PEER, addrs, [OCEAN_PROTOCOL])
  assert.equal(
    published.length,
    1,
    'a message the broker never accepted must be retried on the next update'
  )
})

test('backpressure (a false sendToQueue) still counts as delivered and is deduplicated', async () => {
  // amqplib returns false when its write buffer is full, but the message is still
  // queued - so an identical follow-up update must not republish it.
  const sent = []
  internals.setRabbitChannel({
    sendToQueue(queue, buffer) {
      sent.push({ queue, payload: JSON.parse(buffer.toString('utf8')) })
      return false
    }
  })
  const addrs = addressObjects('/ip4/1.2.3.4/tcp/9000')
  await internals.notifyQueue('update', PEER, addrs, [OCEAN_PROTOCOL])
  await internals.notifyQueue('update', PEER, addrs, [OCEAN_PROTOCOL])
  assert.equal(sent.length, 1, 'a message queued under backpressure must not be resent')
})
