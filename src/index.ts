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
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht'
import { peerIdFromString, peerIdFromPrivateKey } from '@libp2p/peer-id'
import { privateKeyFromRaw } from '@libp2p/crypto/keys'
import type { OceanNodeKeys } from './@types'
import { autoTLS } from '@ipshipyard/libp2p-auto-tls'
import { keychain } from '@libp2p/keychain'
import { http } from '@libp2p/http'
import { tls } from '@libp2p/tls'
import amqp from 'amqplib'
import { multiaddr } from '@multiformats/multiaddr'
import ipaddr from 'ipaddr.js'

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

/** Defaults aligned with ocean-node `p2pConfig` schema */
const P2P_DEFAULTS = {
  mDNSInterval: 20_000,
  connectionsMaxParallelDials: 15,
  connectionsDialTimeout: 30_000,
  maxConnections: 300,
  maxPeerAddrsToDial: 5,
  minConnections: 1
}

let libp2p: Libp2p | null = null
let rabbitChannel: amqp.Channel | null = null

function circuitRelayServerEnabled(): boolean {
  const v =
    process.env.enableCircuitRelayServer ?? process.env.ENABLE_CIRCUIT_RELAY_SERVER
  return v === 'true' || v === '1'
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
    const addressString = maddr.nodeAddress().address
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

async function start() {
  libp2p = await createNode()
  if (!libp2p) {
    return
  }

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
  libp2p.addEventListener('certificate:provision', () => {
    handleCertificateProvision()
  })
  libp2p.addEventListener('certificate:renew', () => {
    handleCertificateRenew()
  })
  if (process.env.RABBITMQ_URL) {
    try {
      const connection = await amqp.connect(process.env.RABBITMQ_URL)
      rabbitChannel = await connection.createChannel()
      await rabbitChannel.assertQueue('discover_queue', { durable: false })
      await rabbitChannel.prefetch(1)
    } catch (e) {
      console.error('Cannot connect to RabbitMQ')
      console.error(e)
    }
  }
}

function handleCertificateProvision() {
  console.info('----- A TLS certificate was provisioned -----')
  const interval = setInterval(() => {
    if (!libp2p) {
      clearInterval(interval)
      return
    }
    const mas = libp2p
      .getMultiaddrs()
      .filter((ma) => ma.toString().includes('/sni/'))
      .map((ma) => ma.toString())
    if (mas.length > 0) {
      console.info('----- TLS addresses: -----')
      console.info(mas.join('\n'))
      console.info('----- End of TLS addresses -----')
    }
    clearInterval(interval)
  }, 1_000)
}

function handleCertificateRenew() {
  console.info('----- A TLS certificate was renewed -----')
}

async function notifyQueue(event: string, peerId: string, addrs: any) {
  const multiaddrs: string[] = []
  if (addrs) {
    for (let i = 0; i < addrs.length; i++) {
      multiaddrs.push(addrs[i].toString())
    }
  }
  try {
    if (!libp2p) return
    const peerStoreId = peerIdFromString(peerId)
    const peerData = await libp2p.peerStore.get(peerStoreId, {
      signal: AbortSignal.timeout(2000)
    })
    if (peerData) {
      for (const x of peerData.addresses) {
        multiaddrs.push(x.multiaddr.toString())
      }
    }
  } catch (e) {
    // it's fine if we don't find it
  }

  const data = {
    peerId: peerId.toString(),
    event,
    timestamp: new Date().getTime(),
    multiaddrs
  }
  console.log(data)

  if (rabbitChannel) {
    try {
      console.log('Sending to RabbitMQ:')
      console.log(data)
      rabbitChannel.sendToQueue('discover_queue', Buffer.from(JSON.stringify(data)))
    } catch (e) {
      console.error(e)
    }
  }
}

function handlePeerConnect(details: any) {
  if (details) {
    const peerId = details.detail
    console.debug('Connection established to:' + peerId.toString())
    // notifyQueue('connect', peerId.toString(), null)
  }
}
function handlePeerUpdate(evt: any) {
  if (evt) {
    const { peer } = evt.detail
    // console.log(peer)
    console.log(`Updated protocols for ${peer.id}:`, peer.protocols)
    if (peer && peer.protocols && peer.protocols.includes('/ocean/nodes/1.0.0'))
      notifyQueue('update', peer.id.toString(), peer.addresses)
  }
}

function handlePeerDisconnect(details: any) {
  if (details) {
    const peerId = details.detail
    console.debug('Connection closed to:' + peerId.toString())
  }
}

function handlePeerDiscovery(details: any) {
  try {
    const peerInfo = details.detail
    console.debug('Discovered new peer:' + peerInfo.id.toString())

    if (!libp2p) return
    const currentConnections = libp2p.getConnections().length
    const { minConnections, maxConnections } = P2P_DEFAULTS

    if (currentConnections < minConnections || currentConnections < maxConnections) {
      const existingConnections = libp2p.getConnections(peerInfo.id)
      if (existingConnections.length === 0) {
        libp2p
          .dial(peerInfo.id, {
            signal: AbortSignal.timeout(10_000)
          })
          .catch((err: Error) => {
            console.debug(`Failed to dial discovered peer ${peerInfo.id}: ${err.message}`)
          })
      }
    }
    // we have no protocols here,so we don't queue
    // notifyQueue('discover', peerInfo.id.toString(), peerInfo.multiaddrs)
  } catch (e) {
    // no panic if it failed
  }
}

async function createNode(): Promise<Libp2p | null> {
  try {
    const nodeKeys = getPeerIdFromPrivateKey(String(process.env.PRIVATE_KEY))

    const bindInterfaces = [
      `/ip4/0.0.0.0/tcp/1000`,
      `/ip4/0.0.0.0/tcp/1001/ws`,
      `/ip6/::1/tcp/1002`,
      `/ip6/::1/tcp/1003/ws`
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

    const dhtOptions = {
      allowQueryWithZeroPeers: false,
      maxInboundStreams: 100,
      maxOutboundStreams: 100,
      clientMode: false,
      kBucketSize: 20,
      protocol: '/ocean/nodes/1.0.0/kad/1.0.0',
      peerInfoMapper: passthroughMapper
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

    if (circuitRelayServerEnabled()) {
      console.info('Enabling Circuit Relay Server')
      servicesConfig = {
        ...servicesConfig,
        circuitRelay: circuitRelayServer({ reservations: { maxReservations: 2 } })
      }
    }

    const transports = [webSockets(), tcp(), circuitRelayTransport()]

    const options: any = {
      addresses,
      privateKey: nodeKeys.privateKey,
      transports,
      streamMuxers: [yamux()],
      connectionEncrypters: [noise(), tls()],
      services: servicesConfig,
      connectionManager: {
        maxParallelDials: P2P_DEFAULTS.connectionsMaxParallelDials,
        dialTimeout: P2P_DEFAULTS.connectionsDialTimeout,
        maxConnections: P2P_DEFAULTS.maxConnections,
        maxPeerAddrsToDial: P2P_DEFAULTS.maxPeerAddrsToDial
      },
      connectionMonitor: {
        abortConnectionOnPingFailure: false
      },
      peerDiscovery: [
        mdns({
          interval: P2P_DEFAULTS.mDNSInterval
        })
      ]
    }

    const node = await createLibp2p(options)
    await node.start()

    console.log('P2P Node started, peer:', nodeKeys.peerId.toString())
    return node
  } catch (e) {
    console.error(e)
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

await start()
