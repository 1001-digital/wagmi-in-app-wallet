import { argon2idAsync } from '@noble/hashes/argon2.js'
import { getAddress } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import {
  DEFAULT_DERIVATION_PATH,
  WALLET_VAULT_VERSION,
  type Argon2idParameters,
  type EncryptedWalletVaultV1,
  type PasskeyKeySlot,
  type PassphraseKeySlot,
  type RuntimeAccount,
  type VaultKeySlot,
  type WrappedVaultKey,
} from './types.js'
import {
  asArrayBuffer,
  base64UrlToBytes,
  bytesToBase64Url,
  clearBytes,
  randomBytes,
} from './encoding.js'
import { VaultIntegrityError, WalletLockedError } from './errors.js'

export const DEFAULT_ARGON2ID_PARAMETERS: Argon2idParameters = {
  algorithm: 'argon2id',
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
  outputLength: 32,
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function payloadAad(document: {
  id: string
  scope: string
  address: string
  derivationPath: string
}): Uint8Array {
  return encoder.encode(
    [
      'networked-wallet-vault',
      WALLET_VAULT_VERSION,
      document.id,
      document.scope,
      document.address,
      document.derivationPath,
    ].join(':'),
  )
}

function slotAad(
  document: Pick<EncryptedWalletVaultV1, 'id' | 'scope'>,
  slot: Pick<VaultKeySlot, 'id' | 'type'>,
): Uint8Array {
  return encoder.encode(
    ['networked-wallet-key-slot', document.id, document.scope, slot.type, slot.id].join(
      ':',
    ),
  )
}

async function importAesKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asArrayBuffer(bytes), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

async function encrypt(
  plaintext: Uint8Array,
  keyBytes: Uint8Array,
  aad: Uint8Array,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = randomBytes(12)
  const key = await importAesKey(keyBytes)
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: asArrayBuffer(iv),
      additionalData: asArrayBuffer(aad),
      tagLength: 128,
    },
    key,
    asArrayBuffer(plaintext),
  )
  return {
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  }
}

async function decrypt(
  encrypted: { iv: string; ciphertext: string },
  keyBytes: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  try {
    const key = await importAesKey(keyBytes)
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: asArrayBuffer(base64UrlToBytes(encrypted.iv)),
        additionalData: asArrayBuffer(aad),
        tagLength: 128,
      },
      key,
      asArrayBuffer(base64UrlToBytes(encrypted.ciphertext)),
    )
    return new Uint8Array(plaintext)
  } catch {
    throw new VaultIntegrityError()
  }
}

export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/gu, ' ')
}

export function deriveRuntimeAccount(
  mnemonic: string,
  derivationPath: `m/44'/60'/${string}` = DEFAULT_DERIVATION_PATH,
): RuntimeAccount {
  const account = mnemonicToAccount(normalizeMnemonic(mnemonic), {
    path: derivationPath,
  })
  return {
    address: getAddress(account.address),
    publicKey: account.publicKey,
  }
}

export async function derivePassphraseWrappingKey(
  passphrase: string,
  salt: Uint8Array,
  parameters: Argon2idParameters,
): Promise<Uint8Array> {
  if (
    parameters.algorithm !== DEFAULT_ARGON2ID_PARAMETERS.algorithm ||
    parameters.memoryKiB !== DEFAULT_ARGON2ID_PARAMETERS.memoryKiB ||
    parameters.iterations !== DEFAULT_ARGON2ID_PARAMETERS.iterations ||
    parameters.parallelism !== DEFAULT_ARGON2ID_PARAMETERS.parallelism ||
    parameters.outputLength !== DEFAULT_ARGON2ID_PARAMETERS.outputLength ||
    salt.length !== 16
  ) {
    throw new VaultIntegrityError('Unsupported wallet vault KDF parameters')
  }
  const password = encoder.encode(passphrase)
  try {
    return await argon2idAsync(password, salt, {
      m: parameters.memoryKiB,
      t: parameters.iterations,
      p: parameters.parallelism,
      dkLen: parameters.outputLength,
    })
  } finally {
    clearBytes(password)
  }
}

export async function wrapVaultKey(
  document: Pick<EncryptedWalletVaultV1, 'id' | 'scope'>,
  slot: Pick<VaultKeySlot, 'id' | 'type'>,
  vaultKey: Uint8Array,
  wrappingKey: Uint8Array,
): Promise<WrappedVaultKey> {
  const wrapped = await encrypt(vaultKey, wrappingKey, slotAad(document, slot))
  return { algorithm: 'AES-256-GCM', ...wrapped }
}

export async function unwrapVaultKey(
  document: Pick<EncryptedWalletVaultV1, 'id' | 'scope'>,
  slot: VaultKeySlot,
  wrappingKey: Uint8Array,
): Promise<Uint8Array> {
  return decrypt(slot.wrappedKey, wrappingKey, slotAad(document, slot))
}

export async function createEncryptedVault(input: {
  id: string
  scope: string
  mnemonic: string
  passphrase: string
  derivationPath?: `m/44'/60'/${string}`
}): Promise<{
  document: EncryptedWalletVaultV1
  vaultKey: Uint8Array
  mnemonic: string
  account: RuntimeAccount
}> {
  const mnemonic = normalizeMnemonic(input.mnemonic)
  const derivationPath = input.derivationPath ?? DEFAULT_DERIVATION_PATH
  const account = deriveRuntimeAccount(mnemonic, derivationPath)
  const vaultKey = randomBytes(32)
  const salt = randomBytes(16)
  const slot: Omit<PassphraseKeySlot, 'wrappedKey'> = {
    id: crypto.randomUUID(),
    type: 'passphrase',
    salt: bytesToBase64Url(salt),
    kdf: DEFAULT_ARGON2ID_PARAMETERS,
  }
  const documentBase = {
    version: WALLET_VAULT_VERSION,
    id: input.id,
    scope: input.scope,
    address: account.address,
    derivationPath,
  } satisfies Omit<EncryptedWalletVaultV1, 'payload' | 'keySlots'>
  const wrappingKey = await derivePassphraseWrappingKey(
    input.passphrase,
    salt,
    slot.kdf,
  )
  try {
    const wrappedKey = await wrapVaultKey(documentBase, slot, vaultKey, wrappingKey)
    const plaintext = encoder.encode(JSON.stringify({ mnemonic }))
    try {
      const payload = await encrypt(plaintext, vaultKey, payloadAad(documentBase))
      return {
        document: {
          ...documentBase,
          payload: { algorithm: 'AES-256-GCM', ...payload },
          keySlots: [{ ...slot, wrappedKey }],
        },
        vaultKey,
        mnemonic,
        account,
      }
    } finally {
      clearBytes(plaintext)
    }
  } finally {
    clearBytes(wrappingKey)
    clearBytes(salt)
  }
}

export async function unlockEncryptedVaultWithPassphrase(
  document: EncryptedWalletVaultV1,
  passphrase: string,
): Promise<{ vaultKey: Uint8Array; mnemonic: string; account: RuntimeAccount }> {
  const slot = document.keySlots.find(
    (candidate): candidate is PassphraseKeySlot =>
      candidate.type === 'passphrase',
  )
  if (!slot) throw new VaultIntegrityError('The vault has no passphrase key slot')
  const wrappingKey = await derivePassphraseWrappingKey(
    passphrase,
    base64UrlToBytes(slot.salt),
    slot.kdf,
  )
  try {
    return unlockEncryptedVaultWithKey(document, slot, wrappingKey)
  } finally {
    clearBytes(wrappingKey)
  }
}

export async function unlockEncryptedVaultWithKey(
  document: EncryptedWalletVaultV1,
  slot: VaultKeySlot,
  wrappingKey: Uint8Array,
): Promise<{ vaultKey: Uint8Array; mnemonic: string; account: RuntimeAccount }> {
  if (document.version !== WALLET_VAULT_VERSION) {
    throw new VaultIntegrityError('Unsupported wallet vault version')
  }
  const vaultKey = await unwrapVaultKey(document, slot, wrappingKey)
  try {
    const plaintext = await decrypt(
      document.payload,
      vaultKey,
      payloadAad(document),
    )
    try {
      const parsed = JSON.parse(decoder.decode(plaintext)) as { mnemonic?: unknown }
      if (typeof parsed.mnemonic !== 'string') throw new VaultIntegrityError()
      const mnemonic = normalizeMnemonic(parsed.mnemonic)
      const account = deriveRuntimeAccount(mnemonic, document.derivationPath)
      if (getAddress(account.address) !== getAddress(document.address)) {
        throw new VaultIntegrityError('The encrypted seed does not match the vault address')
      }
      return { vaultKey, mnemonic, account }
    } finally {
      clearBytes(plaintext)
    }
  } catch (error) {
    clearBytes(vaultKey)
    throw error
  }
}

export async function replacePassphraseSlot(
  document: EncryptedWalletVaultV1,
  vaultKey: Uint8Array,
  passphrase: string,
): Promise<EncryptedWalletVaultV1> {
  const salt = randomBytes(16)
  const slot: Omit<PassphraseKeySlot, 'wrappedKey'> = {
    id: crypto.randomUUID(),
    type: 'passphrase',
    salt: bytesToBase64Url(salt),
    kdf: DEFAULT_ARGON2ID_PARAMETERS,
  }
  const wrappingKey = await derivePassphraseWrappingKey(
    passphrase,
    salt,
    slot.kdf,
  )
  try {
    const wrappedKey = await wrapVaultKey(document, slot, vaultKey, wrappingKey)
    return {
      ...document,
      keySlots: [
        { ...slot, wrappedKey },
        ...document.keySlots.filter((candidate) => candidate.type !== 'passphrase'),
      ],
    }
  } finally {
    clearBytes(wrappingKey)
    clearBytes(salt)
  }
}

export async function addWrappedPasskeySlot(
  document: EncryptedWalletVaultV1,
  vaultKey: Uint8Array,
  slot: Omit<PasskeyKeySlot, 'wrappedKey'>,
  wrappingKey: Uint8Array,
): Promise<EncryptedWalletVaultV1> {
  const wrappedKey = await wrapVaultKey(document, slot, vaultKey, wrappingKey)
  return {
    ...document,
    keySlots: [
      ...document.keySlots.filter((candidate) => candidate.id !== slot.id),
      { ...slot, wrappedKey },
    ],
  }
}

export function requireUnlocked<T>(value: T | null): T {
  if (value === null) throw new WalletLockedError()
  return value
}
