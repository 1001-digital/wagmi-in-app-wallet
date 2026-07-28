import type {
  Hash,
  Hex,
  LocalAccount,
  SignableMessage,
  TransactionSerializable,
} from 'viem'
import { toAccount, english, generateMnemonic } from 'viem/accounts'
import { clearBytes } from './encoding.js'
import { VaultConflictError, WalletLockedError } from './errors.js'
import { evaluatePasskey, registerPasskey } from './passkeys.js'
import { createWalletRuntimeClient } from './runtime-client.js'
import {
  DEFAULT_DERIVATION_PATH,
  type EncryptedWalletVaultV1,
  type PasskeyKeySlot,
  type PasskeyRegistrationOptions,
  type RuntimeAccount,
  type SyncedWalletVault,
  type WalletKeyringSnapshot,
  type WalletKeyringStatus,
  type WalletRuntimeClient,
  type WalletVaultStore,
} from './types.js'

type Listener = (snapshot: WalletKeyringSnapshot) => void

export class EncryptedWalletKeyring {
  readonly #store: WalletVaultStore
  #runtime: WalletRuntimeClient
  #synced: SyncedWalletVault | null = null
  #runtimeAccount: RuntimeAccount | null = null
  #status: WalletKeyringStatus = 'empty'
  readonly #listeners = new Set<Listener>()

  constructor(options: {
    store: WalletVaultStore
    runtime?: WalletRuntimeClient
  }) {
    this.#store = options.store
    this.#runtime = options.runtime ?? createWalletRuntimeClient()
  }

  get document(): EncryptedWalletVaultV1 | null {
    return this.#synced?.document ?? null
  }

  get address() {
    return this.#synced?.document.address ?? null
  }

  get status(): WalletKeyringStatus {
    return this.#status
  }

  get isUnlocked(): boolean {
    return this.#status === 'unlocked'
  }

  snapshot(): WalletKeyringSnapshot {
    return {
      status: this.#status,
      address: this.address,
      revision: this.#synced?.revision ?? null,
      passkeys:
        this.#synced?.document.keySlots
          .filter(
            (slot): slot is PasskeyKeySlot => slot.type === 'passkey',
          )
          .map((slot) => ({ id: slot.id, label: slot.label })) ?? [],
    }
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    listener(this.snapshot())
    return () => this.#listeners.delete(listener)
  }

  async load(): Promise<SyncedWalletVault | null> {
    this.lock()
    this.#synced = await this.#store.load()
    this.#status = this.#synced ? 'locked' : 'empty'
    this.#emit()
    return this.#synced
  }

  async create(input: {
    passphrase: string
    scope: string
  }): Promise<{ mnemonic: string; vault: SyncedWalletVault }> {
    const mnemonic = generateMnemonic(english, 128)
    const vault = await this.#createOrReplace({
      mnemonic,
      passphrase: input.passphrase,
      scope: input.scope,
    })
    return { mnemonic, vault }
  }

  async restore(input: {
    mnemonic: string
    passphrase: string
    scope: string
  }): Promise<SyncedWalletVault> {
    return this.#createOrReplace(input)
  }

  async #createOrReplace(input: {
    mnemonic: string
    passphrase: string
    scope: string
  }): Promise<SyncedWalletVault> {
    assertVaultPassphrase(input.passphrase)
    const current = this.#synced
    const id = current?.document.id ?? crypto.randomUUID()
    const result = await this.#runtime.request('createVault', {
      id,
      scope: input.scope,
      mnemonic: input.mnemonic,
      passphrase: input.passphrase,
      derivationPath: DEFAULT_DERIVATION_PATH,
    })
    const synced = await this.#put(result.document, current?.revision ?? null)
    this.#runtimeAccount = result.account
    this.#status = 'unlocked'
    this.#emit()
    return synced
  }

  async unlockWithPassphrase(passphrase: string): Promise<void> {
    const document = this.#requireDocument()
    this.#status = 'unlocking'
    this.#emit()
    try {
      this.#runtimeAccount = await this.#runtime.request(
        'unlockWithPassphrase',
        { document, passphrase },
      )
      this.#status = 'unlocked'
    } catch (error) {
      this.#status = 'locked'
      throw error
    } finally {
      this.#emit()
    }
  }

  async unlockWithPasskey(slotId?: string): Promise<void> {
    const document = this.#requireDocument()
    const slots = document.keySlots.filter(
      (slot): slot is PasskeyKeySlot => slot.type === 'passkey',
    )
    const slot = slotId
      ? slots.find((candidate) => candidate.id === slotId)
      : slots[0]
    if (!slot) throw new Error('Passkey slot not found')
    this.#status = 'unlocking'
    this.#emit()
    const wrappingKey = await evaluatePasskey(document, slot)
    try {
      this.#runtimeAccount = await this.#runtime.request(
        'unlockWithWrappingKey',
        { document, slotId: slot.id, wrappingKey },
      )
      this.#status = 'unlocked'
    } catch (error) {
      this.#status = 'locked'
      throw error
    } finally {
      clearBytes(wrappingKey)
      this.#emit()
    }
  }

  async addPasskey(
    options: PasskeyRegistrationOptions,
  ): Promise<SyncedWalletVault> {
    this.#requireUnlocked()
    const document = this.#requireDocument()
    const registered = await registerPasskey(document, options)
    try {
      const updated = await this.#runtime.request('addPasskeySlot', {
        document,
        slot: registered.slot,
        wrappingKey: registered.wrappingKey,
      })
      return this.#put(updated, this.#synced!.revision)
    } finally {
      clearBytes(registered.wrappingKey)
    }
  }

  async removePasskey(slotId: string): Promise<SyncedWalletVault> {
    this.#requireUnlocked()
    const document = this.#requireDocument()
    const slot = document.keySlots.find(
      (candidate) => candidate.id === slotId && candidate.type === 'passkey',
    )
    if (!slot) throw new Error('Passkey slot not found')
    return this.#put(
      {
        ...document,
        keySlots: document.keySlots.filter(
          (candidate) => candidate.id !== slot.id,
        ),
      },
      this.#synced!.revision,
    )
  }

  async changePassphrase(passphrase: string): Promise<SyncedWalletVault> {
    this.#requireUnlocked()
    assertVaultPassphrase(passphrase)
    const document = this.#requireDocument()
    const updated = await this.#runtime.request('changePassphrase', {
      document,
      passphrase,
    })
    return this.#put(updated, this.#synced!.revision)
  }

  async exportMnemonic(): Promise<string> {
    this.#requireUnlocked()
    return this.#runtime.request('exportMnemonic', undefined)
  }

  asAccount(): LocalAccount {
    const runtimeAccount = this.#runtimeAccount
    if (!runtimeAccount || !this.isUnlocked) throw new WalletLockedError()
    return toAccount({
      address: runtimeAccount.address,
      sign: ({ hash }) => this.sign({ hash }),
      signMessage: ({ message }) => this.signMessage({ message }),
      signTransaction: (transaction) => this.signTransaction(transaction),
      signTypedData: (typedData) =>
        this.signTypedData(typedData as unknown as Record<string, unknown>),
    })
  }

  sign(input: { hash: Hash }): Promise<Hex> {
    this.#requireUnlocked()
    return this.#runtime.request('sign', input)
  }

  signMessage(input: { message: SignableMessage }): Promise<Hex> {
    this.#requireUnlocked()
    return this.#runtime.request('signMessage', input)
  }

  signTransaction(
    transaction: TransactionSerializable,
  ): Promise<Hex> {
    this.#requireUnlocked()
    return this.#runtime.request('signTransaction', { transaction })
  }

  signTypedData(
    typedData: Record<string, unknown>,
  ): Promise<Hex> {
    this.#requireUnlocked()
    return this.#runtime.request('signTypedData', { typedData })
  }

  lock(): void {
    void this.#runtime.request('lock', undefined).catch(() => undefined)
    this.#runtimeAccount = null
    this.#status = this.#synced ? 'locked' : 'empty'
    this.#emit()
  }

  destroy(): void {
    this.#runtime.destroy()
    this.#runtimeAccount = null
    this.#status = this.#synced ? 'locked' : 'empty'
    this.#emit()
  }

  async #put(
    document: EncryptedWalletVaultV1,
    expectedRevision: number | null,
  ): Promise<SyncedWalletVault> {
    try {
      this.#synced = await this.#store.put(document, expectedRevision)
      this.#emit()
      return this.#synced
    } catch (error) {
      this.lock()
      if (
        error instanceof VaultConflictError ||
        (typeof error === 'object' &&
          error !== null &&
          'status' in error &&
          error.status === 409)
      ) {
        throw new VaultConflictError()
      }
      throw error
    }
  }

  #requireDocument(): EncryptedWalletVaultV1 {
    if (!this.#synced) throw new Error('No synchronized wallet vault is loaded')
    return this.#synced.document
  }

  #requireUnlocked(): void {
    if (!this.isUnlocked) throw new WalletLockedError()
  }

  #emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.#listeners) listener(snapshot)
  }
}

export function assertVaultPassphrase(passphrase: string): void {
  if (passphrase.length < 12) {
    throw new Error('The wallet passphrase must contain at least 12 characters')
  }
}
