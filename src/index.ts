import { createConnector } from '@wagmi/core'
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  hexToBigInt,
  hexToNumber,
  http,
  numberToHex,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

const STORAGE_KEY = 'evm:in-app-wallet-pk'

/**
 * Derive a private key from a BIP39 mnemonic and store it in localStorage.
 * Call this before `connectAsync({ connector })`.
 */
export async function prepareInAppWallet(mnemonic: string): Promise<Address> {
  const { mnemonicToAccount } = await import('viem/accounts')
  const { bytesToHex } = await import('viem')

  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
  const hdAccount = mnemonicToAccount(normalized)
  const hdKey = hdAccount.getHdKey()
  const pk = bytesToHex(hdKey.privateKey!) as `0x${string}`

  localStorage.setItem(STORAGE_KEY, pk)
  return hdAccount.address
}

export type InAppWalletParameters = {
  storageKey?: string
}

inAppWallet.type = 'inAppWallet' as const

export function inAppWallet(parameters: InAppWalletParameters = {}) {
  const key = parameters.storageKey ?? STORAGE_KEY

  type Provider =
    ReturnType<typeof custom> extends (...args: infer A) => infer R ? R : never

  // @ts-expect-error wagmi 0.4.x withCapabilities conditional return type
  return createConnector<Provider>((config) => {
    let account: PrivateKeyAccount | null = null
    let currentChainId: number = config.chains[0].id

    function loadAccount(): PrivateKeyAccount | null {
      if (typeof window === 'undefined') return null
      try {
        const stored = localStorage.getItem(key)
        if (stored?.startsWith('0x')) {
          account = privateKeyToAccount(stored as `0x${string}`)
          return account
        }
      } catch {}
      return null
    }

    function getChain(chainId?: number) {
      return (
        config.chains.find((c) => c.id === (chainId ?? currentChainId)) ??
        config.chains[0]
      )
    }

    return {
      id: 'inAppWallet',
      name: 'In App',
      type: inAppWallet.type,

      async connect({ chainId } = {}) {
        const acct = account ?? loadAccount()
        if (!acct) throw new Error('No in-app wallet key found in storage')

        if (chainId) currentChainId = chainId

        return {
          accounts: [getAddress(acct.address)],
          chainId: currentChainId,
        }
      },

      async disconnect() {
        account = null
        if (typeof window !== 'undefined') {
          localStorage.removeItem(key)
        }
      },

      async getAccounts() {
        const acct = account ?? loadAccount()
        return acct ? [getAddress(acct.address)] : []
      },

      async getChainId() {
        return currentChainId
      },

      async getProvider() {
        const chain = getChain()
        const transport = config.transports?.[chain.id] ?? http()

        const request = async ({
          method,
          params,
        }: {
          method: string
          params?: unknown[]
        }): Promise<unknown> => {
          // Account methods
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
            return account ? [account.address] : []
          }
          if (method === 'eth_chainId') {
            return numberToHex(currentChainId)
          }

          // Signing methods — handled locally
          if (method === 'personal_sign') {
            if (!account) throw new Error('Not connected')
            const [data] = params as [Hex, Address]
            return account.signMessage({ message: { raw: data } })
          }
          if (method === 'eth_signTypedData_v4') {
            if (!account) throw new Error('Not connected')
            const [, typedDataJson] = params as [Address, string]
            const typedData = JSON.parse(typedDataJson)
            return account.signTypedData(typedData)
          }
          if (method === 'eth_sign') {
            if (!account) throw new Error('Not connected')
            const [, data] = params as [Address, Hex]
            return account.sign!({ hash: data })
          }

          // Send transaction — sign locally, broadcast via RPC
          if (method === 'eth_sendTransaction') {
            if (!account) throw new Error('Not connected')
            const [tx] = params as [Record<string, string>]
            const walletClient = createWalletClient({
              account,
              chain,
              transport,
            })
            return walletClient.sendTransaction({
              chain,
              to: tx.to as Address,
              data: tx.data as Hex | undefined,
              value: tx.value ? hexToBigInt(tx.value as Hex) : undefined,
              gas: tx.gas ? hexToBigInt(tx.gas as Hex) : undefined,
              nonce:
                tx.nonce != null ? hexToNumber(tx.nonce as Hex) : undefined,
            })
          }

          // Chain switching
          if (method === 'wallet_switchEthereumChain') {
            const [{ chainId: hexChainId }] = params as [
              { chainId: `0x${string}` },
            ]
            const newChainId = hexToNumber(hexChainId)
            const chain = config.chains.find((c) => c.id === newChainId)
            if (!chain) throw new Error('Chain not configured')
            currentChainId = newChainId
            config.emitter.emit('change', { chainId: newChainId })
            return null
          }

          // Everything else — forward to RPC
          const publicClient = createPublicClient({ chain, transport })
          return (
            publicClient as unknown as {
              request: (args: {
                method: string
                params?: unknown[]
              }) => Promise<unknown>
            }
          ).request({ method, params: params as unknown[] })
        }

        return custom({ request })({ retryCount: 0 })
      },

      async isAuthorized() {
        const acct = account ?? loadAccount()
        return !!acct
      },

      async switchChain({ chainId }) {
        const chain = config.chains.find((c) => c.id === chainId)
        if (!chain) throw new Error('Chain not configured')
        currentChainId = chainId
        config.emitter.emit('change', { chainId })
        return chain
      },

      onAccountsChanged(accounts) {
        if (accounts.length === 0) this.onDisconnect()
        else
          config.emitter.emit('change', {
            accounts: accounts.map((a) => getAddress(a)),
          })
      },

      onChainChanged(chain) {
        const chainId = Number(chain)
        config.emitter.emit('change', { chainId })
      },

      onDisconnect() {
        config.emitter.emit('disconnect')
        account = null
      },
    }
  })
}
