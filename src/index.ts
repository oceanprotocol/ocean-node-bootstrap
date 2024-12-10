import { noise } from '@chainsafe/libp2p-noise'
import { mdns } from '@libp2p/mdns'
import { yamux } from '@chainsafe/libp2p-yamux'

import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { createLibp2p, Libp2p } from 'libp2p'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { dcutr } from '@libp2p/dcutr'
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht'
import { createFromPrivKey } from '@libp2p/peer-id-factory'
import type { OceanNodeKeys } from './@types'
import { keys } from '@libp2p/crypto'
import amqp from 'amqplib'

let libp2p: any
let rabbitChannel: any = null

async function start(options: any = null) {
  libp2p = await createNode()

  libp2p.addEventListener('peer:connect', (evt: any) => {
    handlePeerConnect(evt)
  })
  libp2p.addEventListener('peer:disconnect', (evt: any) => {
    handlePeerDisconnect(evt)
  })
  libp2p.addEventListener('peer:discovery', (details: any) => {
    handlePeerDiscovery(details)
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

function notifyQueue(event: string, peerId: string, addrs: any) {
  const multiaddrs = []
  for (const one of addrs) multiaddrs.push(one.toString())
  const data = {
    peerId: peerId.toString(),
    event,
    timestamp: Math.floor(Date.now() / 1000),
    multiaddrs
  }
  // console.log('Sending to RabbitMQ:')
  // console.log(data)
  if (rabbitChannel) {
    try {
      rabbitChannel.sendToQueue('discover_queue', Buffer.from(JSON.stringify(data)))
    } catch (e) {
      console.error(e)
    }
  }
}

function handlePeerConnect(details: any) {
  if (details) {
    const peerId = details.detail
    console.debug('Connection established to:' + peerId.toString()) // Emitted when a peer has been found
    notifyQueue('connect', peerId.toString(), null) // we don't have multiaddr on connect
  }
}

function handlePeerDisconnect(details: any) {
  if (details) {
    const peerId = details.detail
    console.debug('Connection closed to:' + peerId.toString()) // Emitted when a peer has been found
  }
}

function handlePeerDiscovery(details: any) {
  try {
    const peerInfo = details.detail
    console.debug('Discovered new peer:' + peerInfo.id.toString())
    notifyQueue('discover', peerInfo.id.toString(), peerInfo.multiaddrs)
  } catch (e) {
    // no panic if it failed
    // console.error(e)
  }
}

async function createNode(): Promise<Libp2p | null> {
  try {
    const nodeKeys = await getPeerIdFromPrivateKey(String(process.env.PRIVATE_KEY))
    /** @type {import('libp2p').Libp2pOptions} */
    // start with some default, overwrite based on config later
    const bindInterfaces = [
      `/ip4/0.0.0.0/tcp/9000`,
      `/ip4/0.0.0.0/tcp/9001/ws`,
      `/ip6/::1/tcp/9002`,
      `/ip6/::1/tcp/9003/ws`
    ]
    const addresses = {
      listen: bindInterfaces
    }

    let servicesConfig = {
      identify: identify(),
      dht: kadDHT({
        allowQueryWithZeroPeers: true,
        maxInboundStreams: 100,
        maxOutboundStreams: 100,
        clientMode: false,
        kBucketSize: 20,
        protocol: '/ocean/nodes/1.0.0/kad/1.0.0',
        peerInfoMapper: passthroughMapper
      }),
      ping: ping(),
      dcutr: dcutr()
    }
    // eslint-disable-next-line no-constant-condition, no-self-compare
    if (process.env.enableCircuitRelayServer) {
      console.info('Enabling Circuit Relay Server')
      servicesConfig = { ...servicesConfig, ...{ circuitRelay: circuitRelayServer() } }
    }
    const transports = [webSockets(), tcp()]

    let options = {
      addresses,
      peerId: nodeKeys.peerId,
      transports,
      streamMuxers: [yamux()],
      connectionEncryption: [
        noise()
        // plaintext()
      ],
      services: servicesConfig,
      connectionManager: {
        maxParallelDials: 150,
        dialTimeout: 5,
        minConnections: 0,
        maxConnections: 5000
      }
    }
    options = {
      ...options,
      ...{
        peerDiscovery: [
          mdns({
            interval: 10000
          }) /*,
              pubsubPeerDiscovery({
                interval: config.p2pConfig.pubsubPeerDiscoveryInterval,
                topics: [
                  // 'oceanprotocoldiscovery',
                  `oceanprotocol._peer-discovery._p2p._pubsub` // It's recommended but not required to extend the global space
                  // '_peer-discovery._p2p._pubsub' // Include if you want to participate in the global space
                ],
                listenOnly: false
              }) */
        ]
      }
    }

    const node = await createLibp2p(options)
    await node.start()

    try {
      await node.services.dht.setMode('server')
    } catch (e) {
      console.warn(`Failed to set mode server for DHT`)
    }
    console.log('P2P Node started')
    return node
  } catch (e) {
    console.error(e)
  }
  return null
}

function hexStringToByteArray(hexString: any) {
  if (hexString.length % 2 !== 0) {
    throw new Error('Must have an even number of hex digits to convert to bytes')
  } /* w w w.  jav  a2 s .  c o  m */
  const numBytes = hexString.length / 2
  const byteArray = new Uint8Array(numBytes)
  for (let i = 0; i < numBytes; i++) {
    byteArray[i] = parseInt(hexString.substr(i * 2, 2), 16)
  }
  return byteArray
}

async function getPeerIdFromPrivateKey(privateKey: string): Promise<OceanNodeKeys> {
  const key = new keys.supportedKeys.secp256k1.Secp256k1PrivateKey(
    hexStringToByteArray(privateKey.slice(2))
  )

  return {
    peerId: await createFromPrivKey(key),
    publicKey: key.public.bytes,
    // Notes:
    // using 'key.public.bytes' gives extra 4 bytes: 08021221
    // using (key as any)._publicKey is stripping this same 4 bytes at the beginning: 08021221
    // when getting the peer details with 'peerIdFromString(peerName)' it returns the version with the 4 extra bytes
    // and we also need to send that to the client, so he can uncompress the public key correctly and perform the check and the encryption
    // so it would make more sense to use this value on the configuration
    privateKey: (key as any)._key
  }
}

await start()
