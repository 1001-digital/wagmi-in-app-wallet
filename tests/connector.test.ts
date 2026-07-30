import { createConfig, http } from '@wagmi/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mainnet } from 'viem/chains'
import { forgetInAppWallet, inAppWallet } from '../src/index'

const storageKey = 'test:in-app-wallet'
const privateKey =
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('inAppWallet storage', () => {
  it('preserves the private key on disconnect and forgets it explicitly', async () => {
    const storage = memoryStorage()
    storage.setItem(storageKey, privateKey)
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('localStorage', storage)

    const config = createConfig({
      chains: [mainnet],
      connectors: [inAppWallet({ storageKey })],
      transports: { [mainnet.id]: http() },
    })
    const connector = config.connectors[0]!

    await connector.connect()
    await connector.disconnect()
    expect(storage.getItem(storageKey)).toBe(privateKey)

    forgetInAppWallet(storageKey)
    expect(storage.getItem(storageKey)).toBeNull()
  })
})
