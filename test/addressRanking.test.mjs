import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { multiaddr } from '@multiformats/multiaddr'
import { captureQueue, cleanupHarness, loadBootstrapInternals } from './harness.mjs'

let internals
let published

before(async () => {
  internals = await loadBootstrapInternals()
  internals.setLibp2p(null)
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

test('directly routable addresses rank ahead of relayed, and relayed ahead of private', () => {
  const ranked = internals.prioritiseMultiaddrs([
    '/ip4/127.0.0.1/tcp/9000',
    '/ip4/10.0.0.5/tcp/9000',
    '/ip4/1.2.3.4/tcp/9000/p2p-circuit/p2p/16Uiu2HAmRelay',
    '/ip4/9.9.9.9/tcp/9000',
    '/dns4/node.example.com/tcp/9001/ws'
  ])
  const rankOf = (addr) => internals.multiaddrRank(addr)
  const ranks = ranked.map(rankOf)
  assert.deepEqual(
    [...ranks].sort((a, b) => a - b),
    ranks,
    `ranking is out of order: ${JSON.stringify(ranked)}`
  )
  // The two publicly routable addresses come first, the relay next, the unroutable last.
  assert.deepEqual(
    new Set(ranked.slice(0, 2)),
    new Set(['/dns4/node.example.com/tcp/9001/ws', '/ip4/9.9.9.9/tcp/9000'])
  )
  assert.equal(ranked[2], '/ip4/1.2.3.4/tcp/9000/p2p-circuit/p2p/16Uiu2HAmRelay')
  assert.deepEqual(
    new Set(ranked.slice(3)),
    new Set(['/ip4/10.0.0.5/tcp/9000', '/ip4/127.0.0.1/tcp/9000'])
  )
})

test('a truncated address list keeps both IPv4 and IPv6 instead of shedding one family', async () => {
  // A plain lexicographic sort puts every `/ip4` before every `/ip6`, so slicing to the
  // per-message cap dropped IPv6 wholesale - and with it the only route to a v6-only peer.
  const addrs = []
  for (let i = 1; i <= 80; i++) {
    addrs.push(multiaddr(`/ip4/9.9.${Math.floor(i / 256)}.${i % 256}/tcp/9000`))
    addrs.push(multiaddr(`/ip6/2606:4700::${i.toString(16)}/tcp/9000`))
  }
  await internals.notifyQueue('update', PEER, addrs, ['/ocean/nodes/1.0.0'])
  const { multiaddrs } = published[0].payload
  assert.equal(multiaddrs.length, internals.MAX_MULTIADDRS_PER_MESSAGE)
  const v4 = multiaddrs.filter((a) => a.startsWith('/ip4/')).length
  const v6 = multiaddrs.filter((a) => a.startsWith('/ip6/')).length
  assert.ok(v6 > 0, `all IPv6 addresses were shed: ${v4} v4 / ${v6} v6`)
  assert.ok(v4 > 0, `all IPv4 addresses were shed: ${v4} v4 / ${v6} v6`)
  // interleaved, so neither family can be starved by the cap
  assert.ok(
    Math.abs(v4 - v6) <= 1,
    `families should be interleaved, got ${v4} v4 / ${v6} v6`
  )
})

test('address ordering is deterministic, so the fingerprint over it is stable', () => {
  const input = [
    '/ip6/2606:4700::2/tcp/9000',
    '/ip4/9.9.9.9/tcp/9000',
    '/ip4/10.0.0.5/tcp/9000',
    '/ip6/2606:4700::1/tcp/9000'
  ]
  const once = internals.prioritiseMultiaddrs(input)
  const twice = internals.prioritiseMultiaddrs([...input].reverse())
  assert.deepEqual(once, twice)
})

test('updating a peer already in the fingerprint cache evicts nobody', () => {
  // `Map.set` on an existing key does not reorder it, so evicting `keys().next()` while
  // a busy peer merely updated its entry threw out the longest-lived peer instead - and
  // that peer's own next update then re-published and evicted another.
  const cache = internals.peerFingerprints
  cache.clear()
  const cap = internals.FINGERPRINT_CACHE_SIZE
  for (let i = 0; i < cap; i++) {
    internals.rememberFingerprint(`peer-${i}`, `fp-${i}`)
  }
  internals.rememberFingerprint('peer-5', 'fp-5-changed')
  assert.equal(cache.size, cap, 'the cache must stay bounded')
  assert.ok(cache.has('peer-0'), 'an update to one peer must not evict a different peer')
  assert.equal(cache.get('peer-5'), 'fp-5-changed')

  internals.rememberFingerprint('peer-new', 'fp-new')
  assert.ok(!cache.has('peer-0'), 'the genuinely oldest entry is the one to evict')
  assert.ok(cache.has('peer-5'), 'the peer that just updated must count as recently used')
  cache.clear()
})

test('the fingerprint cache is bounded and evicts the least recently used peer', () => {
  const cache = internals.peerFingerprints
  cache.clear()
  const cap = internals.FINGERPRINT_CACHE_SIZE
  for (let i = 0; i < cap; i++) {
    internals.rememberFingerprint(`peer-${i}`, `fp-${i}`)
  }
  assert.equal(cache.size, cap)

  // A hit is activity: touching the oldest entry must make it the newest, so the next
  // eviction takes the entry after it rather than the peer that is still busy.
  assert.equal(internals.recallFingerprint('peer-0'), 'fp-0')
  internals.rememberFingerprint('peer-new', 'fp-new')

  assert.equal(cache.size, cap, 'the cache must stay bounded')
  assert.ok(cache.has('peer-0'), 'the recently used entry must survive eviction')
  assert.ok(!cache.has('peer-1'), 'the least recently used entry must be evicted')
  assert.ok(cache.has('peer-new'))
  cache.clear()
})
