import type {
  EncryptedWalletVaultV1,
  SyncedWalletVault,
  WalletVaultStore,
} from './types.js'
import { VaultConflictError } from './errors.js'

export function createLocalEncryptedVaultStore(
  storageKey = 'evm:encrypted-in-app-wallet',
): WalletVaultStore {
  return {
    async load() {
      const stored = localStorage.getItem(storageKey)
      if (!stored) return null
      return JSON.parse(stored) as SyncedWalletVault
    },
    async put(
      document: EncryptedWalletVaultV1,
      expectedRevision: number | null,
    ) {
      const current = await this.load()
      if ((current?.revision ?? null) !== expectedRevision) {
        throw new VaultConflictError()
      }
      const synced = {
        document,
        revision: (current?.revision ?? 0) + 1,
      }
      localStorage.setItem(storageKey, JSON.stringify(synced))
      return synced
    },
  }
}
