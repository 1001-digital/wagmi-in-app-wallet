import type {
  Address,
  Hash,
  Hex,
  SignableMessage,
  TransactionSerializable,
} from 'viem'

export const WALLET_VAULT_VERSION = 1 as const
export const DEFAULT_DERIVATION_PATH = "m/44'/60'/0'/0/0" as const

export type Argon2idParameters = {
  algorithm: 'argon2id'
  memoryKiB: number
  iterations: number
  parallelism: number
  outputLength: number
}

export type WrappedVaultKey = {
  algorithm: 'AES-256-GCM'
  iv: string
  ciphertext: string
}

export type PassphraseKeySlot = {
  id: string
  type: 'passphrase'
  salt: string
  kdf: Argon2idParameters
  wrappedKey: WrappedVaultKey
}

export type PasskeyKeySlot = {
  id: string
  type: 'passkey'
  credentialId: string
  prfSalt: string
  rpId: string
  label?: string
  wrappedKey: WrappedVaultKey
}

export type VaultKeySlot = PassphraseKeySlot | PasskeyKeySlot

export type EncryptedWalletVaultV1 = {
  version: typeof WALLET_VAULT_VERSION
  id: string
  scope: string
  address: Address
  derivationPath: `m/44'/60'/${string}`
  payload: {
    algorithm: 'AES-256-GCM'
    iv: string
    ciphertext: string
  }
  keySlots: VaultKeySlot[]
}

export type SyncedWalletVault = {
  document: EncryptedWalletVaultV1
  revision: number
}

export type WalletVaultStore = {
  load(): Promise<SyncedWalletVault | null>
  put(
    document: EncryptedWalletVaultV1,
    expectedRevision: number | null,
  ): Promise<SyncedWalletVault>
}

export type UnlockReason =
  | { method: 'connect' }
  | { method: 'personal_sign'; message: SignableMessage }
  | { method: 'eth_sign'; hash: Hash }
  | {
      method: 'eth_signTypedData_v4'
      typedData: Record<string, unknown>
    }
  | { method: 'eth_sendTransaction'; transaction: Record<string, unknown> }

export type RequestUnlock = (reason: UnlockReason) => Promise<void>

export type RuntimeAccount = {
  address: Address
  publicKey: Hex
}

export type WalletRuntimeRequestMap = {
  createVault: {
    input: {
      id: string
      scope: string
      mnemonic: string
      passphrase: string
      derivationPath: `m/44'/60'/${string}`
    }
    output: { document: EncryptedWalletVaultV1; account: RuntimeAccount }
  }
  unlockWithPassphrase: {
    input: { document: EncryptedWalletVaultV1; passphrase: string }
    output: RuntimeAccount
  }
  unlockWithWrappingKey: {
    input: {
      document: EncryptedWalletVaultV1
      slotId: string
      wrappingKey: Uint8Array
    }
    output: RuntimeAccount
  }
  addPasskeySlot: {
    input: {
      document: EncryptedWalletVaultV1
      slot: Omit<PasskeyKeySlot, 'wrappedKey'>
      wrappingKey: Uint8Array
    }
    output: EncryptedWalletVaultV1
  }
  changePassphrase: {
    input: { document: EncryptedWalletVaultV1; passphrase: string }
    output: EncryptedWalletVaultV1
  }
  exportMnemonic: { input: undefined; output: string }
  sign: { input: { hash: Hash }; output: Hex }
  signMessage: { input: { message: SignableMessage }; output: Hex }
  signTransaction: {
    input: { transaction: TransactionSerializable }
    output: Hex
  }
  signTypedData: {
    input: { typedData: Record<string, unknown> }
    output: Hex
  }
  lock: { input: undefined; output: void }
}

export type WalletRuntimeMethod = keyof WalletRuntimeRequestMap

export type WalletRuntimeClient = {
  request<M extends WalletRuntimeMethod>(
    method: M,
    input: WalletRuntimeRequestMap[M]['input'],
  ): Promise<WalletRuntimeRequestMap[M]['output']>
  destroy(): void
}

export type PasskeyRegistrationOptions = {
  rpName: string
  rpId?: string
  userName?: string
  label?: string
}

export type WalletKeyringStatus =
  | 'empty'
  | 'locked'
  | 'unlocking'
  | 'unlocked'

export type WalletKeyringSnapshot = {
  status: WalletKeyringStatus
  address: Address | null
  revision: number | null
  passkeys: Array<{ id: string; label?: string }>
}
