import { describe, expect, it } from 'vitest'
import { recoverMessageAddress } from 'viem'
import {
  EncryptedWalletKeyring,
  VaultConflictError,
  WalletLockedError,
  type EncryptedWalletVaultV1,
  type SyncedWalletVault,
  type WalletVaultStore,
} from '../src/index.js'

const MNEMONIC =
  'test test test test test test test test test test test junk'
const PASSPHRASE = 'correct horse battery staple'

class MemoryStore implements WalletVaultStore {
  current: SyncedWalletVault | null = null

  async load() {
    return structuredClone(this.current)
  }

  async put(
    document: EncryptedWalletVaultV1,
    expectedRevision: number | null,
  ) {
    if ((this.current?.revision ?? null) !== expectedRevision) {
      throw new VaultConflictError()
    }
    this.current = {
      document: structuredClone(document),
      revision: (this.current?.revision ?? 0) + 1,
    }
    return structuredClone(this.current)
  }
}

describe('EncryptedWalletKeyring', () => {
  it(
    'syncs only ciphertext, locks, unlocks, and signs with the restored account',
    async () => {
      const store = new MemoryStore()
      const keyring = new EncryptedWalletKeyring({ store })

      await keyring.restore({
        mnemonic: MNEMONIC,
        passphrase: PASSPHRASE,
        scope: 'networked.art',
      })

      const address = keyring.address
      expect(address).toBeTruthy()
      expect(JSON.stringify(store.current)).not.toContain(MNEMONIC)
      expect(store.current?.document.keySlots).toHaveLength(1)

      keyring.lock()
      expect(keyring.status).toBe('locked')
      await expect(keyring.exportMnemonic()).rejects.toBeInstanceOf(
        WalletLockedError,
      )

      await keyring.unlockWithPassphrase(PASSPHRASE)
      expect(await keyring.exportMnemonic()).toBe(MNEMONIC)

      const message = 'networked wallet test'
      const signature = await keyring.signMessage({ message })
      expect(
        await recoverMessageAddress({ message, signature }),
      ).toBe(address)

      keyring.destroy()
    },
    30_000,
  )

  it(
    'fails closed when the encrypted payload is modified',
    async () => {
      const store = new MemoryStore()
      const keyring = new EncryptedWalletKeyring({ store })
      await keyring.restore({
        mnemonic: MNEMONIC,
        passphrase: PASSPHRASE,
        scope: 'networked.art',
      })
      keyring.lock()

      const current = store.current!
      current.document.payload.ciphertext =
        `${current.document.payload.ciphertext.slice(0, -1)}A`
      await keyring.load()

      await expect(
        keyring.unlockWithPassphrase(PASSPHRASE),
      ).rejects.toThrow()
      expect(keyring.status).toBe('locked')
      keyring.destroy()
    },
    30_000,
  )

  it('enforces a portable passphrase floor', async () => {
    const keyring = new EncryptedWalletKeyring({
      store: new MemoryStore(),
    })
    await expect(
      keyring.restore({
        mnemonic: MNEMONIC,
        passphrase: 'too short',
        scope: 'networked.art',
      }),
    ).rejects.toThrow('at least 12 characters')
    keyring.destroy()
  })

  it(
    'rejects attacker-controlled KDF costs before deriving a key',
    async () => {
      const store = new MemoryStore()
      const keyring = new EncryptedWalletKeyring({ store })
      await keyring.restore({
        mnemonic: MNEMONIC,
        passphrase: PASSPHRASE,
        scope: 'networked.art',
      })
      keyring.lock()
      const slot = store.current!.document.keySlots[0]
      if (slot.type !== 'passphrase') throw new Error('Missing passphrase slot')
      slot.kdf.memoryKiB = 2 ** 31
      await keyring.load()

      await expect(
        keyring.unlockWithPassphrase(PASSPHRASE),
      ).rejects.toThrow('Unsupported wallet vault KDF parameters')
      keyring.destroy()
    },
    30_000,
  )
})
