/**
 * Derive the libp2p peerId string from `PRIVATE_KEY`, for `service.instance.id`.
 *
 * The peerId is the canonical per-node identity in the dashboards, and it is deterministic
 * from the node key - so it can be computed here, at telemetry-bootstrap time, without
 * waiting for libp2p to start. This mirrors `getPeerIdFromPrivateKey()` in `index.ts`
 * (kept minimal and self-contained so the telemetry module has no dependency on `index.ts`).
 *
 * Async so a future KMS-backed key provider can slot in without changing the call site.
 * Returns `undefined` on any failure - a missing or malformed key must never abort telemetry
 * startup; the caller falls back to a random UUID.
 */
import { privateKeyFromRaw } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

function hexStringToByteArray(hexString: string): Uint8Array {
  const hex = hexString.startsWith('0x') ? hexString.slice(2) : hexString
  if (hex.length % 2 !== 0) {
    throw new Error('Must have an even number of hex digits to convert to bytes')
  }
  // `parseInt` silently accepts partial/invalid input ('1z' -> 1, 'zz' -> NaN -> 0),
  // so validate the whole string is hex up front - a malformed PRIVATE_KEY must fail
  // (and fall back to a random UUID) rather than derive a wrong peer ID.
  if (hex.length > 0 && !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Hex string contains non-hexadecimal characters')
  }
  const numBytes = hex.length / 2
  const byteArray = new Uint8Array(numBytes)
  for (let i = 0; i < numBytes; i++) {
    byteArray[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return byteArray
}

// Not declared `async` (the repo's `require-await` rule forbids an async function with no
// `await`), but it returns a Promise so a future KMS-backed, genuinely-async key provider can
// slot in behind the same signature - and so `otel.ts` can `await` it.
export function derivePeerId(
  privateKey: string | undefined = process.env.PRIVATE_KEY
): Promise<string | undefined> {
  try {
    if (privateKey === undefined || privateKey.trim() === '') {
      return Promise.resolve(undefined)
    }
    const bytes = hexStringToByteArray(privateKey.trim())
    const key = privateKeyFromRaw(bytes)
    return Promise.resolve(peerIdFromPrivateKey(key).toString())
  } catch {
    return Promise.resolve(undefined)
  }
}
