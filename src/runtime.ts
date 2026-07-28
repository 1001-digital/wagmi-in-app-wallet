import type {
  Hash,
  Hex,
  SignableMessage,
  TransactionSerializable,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import {
  addWrappedPasskeySlot,
  createEncryptedVault,
  replacePassphraseSlot,
  requireUnlocked,
  unlockEncryptedVaultWithKey,
  unlockEncryptedVaultWithPassphrase,
} from './crypto.js'
import { clearBytes } from './encoding.js'
import type {
  EncryptedWalletVaultV1,
  RuntimeAccount,
  WalletRuntimeMethod,
  WalletRuntimeRequestMap,
} from './types.js'

export class WalletRuntime {
  #mnemonic: string | null = null
  #vaultKey: Uint8Array | null = null
  #account: ReturnType<typeof mnemonicToAccount> | null = null
  #runtimeAccount: RuntimeAccount | null = null

  async request<M extends WalletRuntimeMethod>(
    method: M,
    input: WalletRuntimeRequestMap[M]['input'],
  ): Promise<WalletRuntimeRequestMap[M]['output']> {
    switch (method) {
      case 'createVault':
        return this.#createVault(
          input as WalletRuntimeRequestMap['createVault']['input'],
        ) as Promise<WalletRuntimeRequestMap[M]['output']>
      case 'unlockWithPassphrase':
        return this.#unlockWithPassphrase(
          input as WalletRuntimeRequestMap['unlockWithPassphrase']['input'],
        ) as Promise<WalletRuntimeRequestMap[M]['output']>
      case 'unlockWithWrappingKey':
        return this.#unlockWithWrappingKey(
          input as WalletRuntimeRequestMap['unlockWithWrappingKey']['input'],
        ) as Promise<WalletRuntimeRequestMap[M]['output']>
      case 'addPasskeySlot':
        return this.#addPasskeySlot(
          input as WalletRuntimeRequestMap['addPasskeySlot']['input'],
        ) as Promise<WalletRuntimeRequestMap[M]['output']>
      case 'changePassphrase':
        return this.#changePassphrase(
          input as WalletRuntimeRequestMap['changePassphrase']['input'],
        ) as Promise<WalletRuntimeRequestMap[M]['output']>
      case 'exportMnemonic':
        return Promise.resolve(
          requireUnlocked(this.#mnemonic),
        ) as Promise<WalletRuntimeRequestMap[M]['output']>
      case 'sign':
        return this.#sign(
          input as WalletRuntimeRequestMap['sign']['input'],
        ) as Promise<WalletRuntimeRequestMap[M]['output']>
      case 'signMessage':
        return this.#signMessage(
          input as WalletRuntimeRequestMap['signMessage']['input'],
        ) as Promise<WalletRuntimeRequestMap[M]['output']>
      case 'signTransaction':
        return this.#signTransaction(
          input as WalletRuntimeRequestMap['signTransaction']['input'],
        ) as Promise<WalletRuntimeRequestMap[M]['output']>
      case 'signTypedData':
        return this.#signTypedData(
          input as WalletRuntimeRequestMap['signTypedData']['input'],
        ) as Promise<WalletRuntimeRequestMap[M]['output']>
      case 'lock':
        this.lock()
        return Promise.resolve() as Promise<WalletRuntimeRequestMap[M]['output']>
    }
  }

  async #createVault(
    input: WalletRuntimeRequestMap['createVault']['input'],
  ): Promise<WalletRuntimeRequestMap['createVault']['output']> {
    const result = await createEncryptedVault(input)
    this.#setUnlocked(
      result.mnemonic,
      result.vaultKey,
      result.account,
      input.derivationPath,
    )
    return { document: result.document, account: result.account }
  }

  async #unlockWithPassphrase(
    input: WalletRuntimeRequestMap['unlockWithPassphrase']['input'],
  ): Promise<RuntimeAccount> {
    const result = await unlockEncryptedVaultWithPassphrase(
      input.document,
      input.passphrase,
    )
    this.#setUnlocked(
      result.mnemonic,
      result.vaultKey,
      result.account,
      input.document.derivationPath,
    )
    return result.account
  }

  async #unlockWithWrappingKey(
    input: WalletRuntimeRequestMap['unlockWithWrappingKey']['input'],
  ): Promise<RuntimeAccount> {
    const slot = input.document.keySlots.find(
      (candidate) => candidate.id === input.slotId,
    )
    if (!slot) throw new Error('Passkey slot not found')
    const result = await unlockEncryptedVaultWithKey(
      input.document,
      slot,
      input.wrappingKey,
    )
    this.#setUnlocked(
      result.mnemonic,
      result.vaultKey,
      result.account,
      input.document.derivationPath,
    )
    return result.account
  }

  async #addPasskeySlot(
    input: WalletRuntimeRequestMap['addPasskeySlot']['input'],
  ): Promise<EncryptedWalletVaultV1> {
    return addWrappedPasskeySlot(
      input.document,
      requireUnlocked(this.#vaultKey),
      input.slot,
      input.wrappingKey,
    )
  }

  async #changePassphrase(
    input: WalletRuntimeRequestMap['changePassphrase']['input'],
  ): Promise<EncryptedWalletVaultV1> {
    return replacePassphraseSlot(
      input.document,
      requireUnlocked(this.#vaultKey),
      input.passphrase,
    )
  }

  async #sign(input: { hash: Hash }): Promise<Hex> {
    return requireUnlocked(this.#account).sign({ hash: input.hash })
  }

  async #signMessage(input: { message: SignableMessage }): Promise<Hex> {
    return requireUnlocked(this.#account).signMessage({ message: input.message })
  }

  async #signTransaction(input: {
    transaction: TransactionSerializable
  }): Promise<Hex> {
    return requireUnlocked(this.#account).signTransaction(input.transaction)
  }

  async #signTypedData(input: {
    typedData: Record<string, unknown>
  }): Promise<Hex> {
    return requireUnlocked(this.#account).signTypedData(
      input.typedData as never,
    )
  }

  #setUnlocked(
    mnemonic: string,
    vaultKey: Uint8Array,
    account: RuntimeAccount,
    derivationPath: `m/44'/60'/${string}`,
  ): void {
    this.lock()
    this.#mnemonic = mnemonic
    this.#vaultKey = vaultKey
    this.#runtimeAccount = account
    this.#account = mnemonicToAccount(mnemonic, {
      path: derivationPath,
    })
  }

  lock(): void {
    clearBytes(this.#vaultKey)
    this.#vaultKey = null
    this.#mnemonic = null
    this.#account = null
    this.#runtimeAccount = null
  }
}
