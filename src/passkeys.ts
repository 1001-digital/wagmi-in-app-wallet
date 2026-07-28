import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  asArrayBuffer,
  base64UrlToBytes,
  bytesToBase64Url,
  randomBytes,
} from './encoding.js'
import { PasskeyPrfUnavailableError } from './errors.js'
import type {
  EncryptedWalletVaultV1,
  PasskeyKeySlot,
  PasskeyRegistrationOptions,
} from './types.js'

type PrfExtensionResults = {
  prf?: {
    enabled?: boolean
    results?: { first?: ArrayBuffer }
  }
}

function extensionResults(
  credential: PublicKeyCredential,
): PrfExtensionResults {
  return credential.getClientExtensionResults() as PrfExtensionResults
}

function deriveWrappingKey(
  prfOutput: ArrayBuffer,
  document: Pick<EncryptedWalletVaultV1, 'id' | 'scope'>,
  slotId: string,
): Uint8Array {
  return hkdf(
    sha256,
    new Uint8Array(prfOutput),
    new TextEncoder().encode(document.id),
    new TextEncoder().encode(
      `networked-wallet-passkey:${document.scope}:${slotId}`,
    ),
    32,
  )
}

async function requestPrfOutput(input: {
  credentialId: Uint8Array
  rpId: string
  prfSalt: Uint8Array
}): Promise<ArrayBuffer> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: asArrayBuffer(randomBytes(32)),
      rpId: input.rpId,
      allowCredentials: [
        {
          type: 'public-key',
          id: asArrayBuffer(input.credentialId),
        },
      ],
      userVerification: 'required',
      timeout: 60_000,
      extensions: {
        prf: {
          eval: { first: asArrayBuffer(input.prfSalt) },
        },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Passkey unlock was cancelled')
  const output = extensionResults(credential).prf?.results?.first
  if (!output) throw new PasskeyPrfUnavailableError()
  return output
}

export async function registerPasskey(
  document: EncryptedWalletVaultV1,
  options: PasskeyRegistrationOptions,
): Promise<{
  slot: Omit<PasskeyKeySlot, 'wrappedKey'>
  wrappingKey: Uint8Array
}> {
  if (!navigator.credentials) throw new PasskeyPrfUnavailableError()
  const slotId = crypto.randomUUID()
  const prfSalt = randomBytes(32)
  const challenge = randomBytes(32)
  const rpId = options.rpId ?? window.location.hostname
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: asArrayBuffer(challenge),
      rp: { name: options.rpName, id: rpId },
      user: {
        id: asArrayBuffer(new TextEncoder().encode(document.id)),
        name: options.userName ?? document.address,
        displayName: options.userName ?? 'In-app wallet',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      timeout: 60_000,
      attestation: 'none',
      extensions: {
        prf: { eval: { first: asArrayBuffer(prfSalt) } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Passkey registration was cancelled')
  const prfOutput =
    extensionResults(credential).prf?.results?.first ??
    (await requestPrfOutput({
      credentialId: new Uint8Array(credential.rawId),
      rpId,
      prfSalt,
    }))
  return {
    slot: {
      id: slotId,
      type: 'passkey',
      credentialId: bytesToBase64Url(new Uint8Array(credential.rawId)),
      prfSalt: bytesToBase64Url(prfSalt),
      rpId,
      label: options.label,
    },
    wrappingKey: deriveWrappingKey(prfOutput, document, slotId),
  }
}

export async function evaluatePasskey(
  document: EncryptedWalletVaultV1,
  slot: PasskeyKeySlot,
): Promise<Uint8Array> {
  if (!navigator.credentials) throw new PasskeyPrfUnavailableError()
  const prfOutput = await requestPrfOutput({
    credentialId: base64UrlToBytes(slot.credentialId),
    rpId: slot.rpId,
    prfSalt: base64UrlToBytes(slot.prfSalt),
  })
  return deriveWrappingKey(prfOutput, document, slot.id)
}
