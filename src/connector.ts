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
import type { EncryptedWalletKeyring } from './keyring.js'
import type { RequestUnlock, UnlockReason } from './types.js'
import { WalletLockedError } from './errors.js'

export type InAppWalletParameters = {
  keyring: EncryptedWalletKeyring
  requestUnlock?: RequestUnlock
  name?: string
}

inAppWallet.type = 'inAppWallet' as const

export function inAppWallet(parameters: InAppWalletParameters) {
  type Provider =
    ReturnType<typeof custom> extends (...args: infer A) => infer R ? R : never

  // @ts-expect-error wagmi withCapabilities conditional return type
  return createConnector<Provider>((config) => {
    let currentChainId: number = config.chains[0].id

    function getChain(chainId?: number) {
      return (
        config.chains.find((chain) => chain.id === (chainId ?? currentChainId)) ??
        config.chains[0]
      )
    }

    async function ensureUnlocked(reason: UnlockReason): Promise<void> {
      if (parameters.keyring.isUnlocked) return
      if (!parameters.requestUnlock) throw new WalletLockedError()
      await parameters.requestUnlock(reason)
      if (!parameters.keyring.isUnlocked) throw new WalletLockedError()
    }

    function assertRequestedAccount(address: string | undefined): void {
      const walletAddress = parameters.keyring.address
      if (
        !walletAddress ||
        !address ||
        getAddress(address) !== getAddress(walletAddress)
      ) {
        throw new Error('Requested account does not match the in-app wallet')
      }
    }

    return {
      id: 'inAppWallet',
      name: parameters.name ?? 'In App',
      type: inAppWallet.type,

      async connect({ chainId } = {}) {
        if (!parameters.keyring.address) {
          await parameters.keyring.load()
        }
        if (!parameters.keyring.address) throw new Error('No in-app wallet vault found')
        if (chainId) {
          const chain = config.chains.find((candidate) => candidate.id === chainId)
          if (!chain) throw new Error('Chain not configured')
          currentChainId = chain.id
        }
        return {
          accounts: [getAddress(parameters.keyring.address)],
          chainId: currentChainId,
        }
      },

      async disconnect() {
        parameters.keyring.lock()
      },

      async getAccounts() {
        return parameters.keyring.address
          ? [getAddress(parameters.keyring.address)]
          : []
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
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
            return parameters.keyring.address
              ? [parameters.keyring.address]
              : []
          }
          if (method === 'eth_chainId') return numberToHex(currentChainId)

          if (method === 'personal_sign') {
            const [data, account] = params as [Hex, Address]
            assertRequestedAccount(account)
            const message = { raw: data } as const
            await ensureUnlocked({ method, message })
            return parameters.keyring.signMessage({ message })
          }
          if (method === 'eth_signTypedData_v4') {
            const [account, typedDataJson] = params as [Address, string]
            assertRequestedAccount(account)
            const typedData = JSON.parse(typedDataJson)
            await ensureUnlocked({ method, typedData })
            return parameters.keyring.signTypedData(typedData)
          }
          if (method === 'eth_sign') {
            const [account, hash] = params as [Address, Hex]
            assertRequestedAccount(account)
            await ensureUnlocked({ method, hash })
            return parameters.keyring.sign({ hash })
          }

          if (method === 'eth_sendTransaction') {
            const [transaction] = params as [Record<string, string>]
            assertRequestedAccount(transaction.from)
            if (
              transaction.chainId &&
              hexToNumber(transaction.chainId as Hex) !== currentChainId
            ) {
              throw new Error('Transaction chain does not match the active chain')
            }
            await ensureUnlocked({ method, transaction })
            const walletClient = createWalletClient({
              account: parameters.keyring.asAccount(),
              chain,
              transport,
            })
            const feeParameters = transaction.maxFeePerGas
              ? {
                  maxFeePerGas: hexToBigInt(transaction.maxFeePerGas as Hex),
                  maxPriorityFeePerGas: transaction.maxPriorityFeePerGas
                    ? hexToBigInt(transaction.maxPriorityFeePerGas as Hex)
                    : undefined,
                }
              : transaction.gasPrice
                ? { gasPrice: hexToBigInt(transaction.gasPrice as Hex) }
                : {}
            return walletClient.sendTransaction({
              chain,
              to: transaction.to as Address | undefined,
              data: transaction.data as Hex | undefined,
              value: transaction.value
                ? hexToBigInt(transaction.value as Hex)
                : undefined,
              gas: transaction.gas
                ? hexToBigInt(transaction.gas as Hex)
                : undefined,
              nonce:
                transaction.nonce != null
                  ? hexToNumber(transaction.nonce as Hex)
                  : undefined,
              ...feeParameters,
            } as never)
          }

          if (method === 'wallet_switchEthereumChain') {
            const [{ chainId: hexChainId }] = params as [
              { chainId: `0x${string}` },
            ]
            const newChainId = hexToNumber(hexChainId)
            const configured = config.chains.find(
              (candidate) => candidate.id === newChainId,
            )
            if (!configured) throw new Error('Chain not configured')
            currentChainId = newChainId
            config.emitter.emit('change', { chainId: newChainId })
            return null
          }

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
        if (!parameters.keyring.address) await parameters.keyring.load()
        return Boolean(parameters.keyring.address)
      },

      async switchChain({ chainId }) {
        const chain = config.chains.find((candidate) => candidate.id === chainId)
        if (!chain) throw new Error('Chain not configured')
        currentChainId = chainId
        config.emitter.emit('change', { chainId })
        return chain
      },

      onAccountsChanged(accounts) {
        if (accounts.length === 0) this.onDisconnect()
        else {
          config.emitter.emit('change', {
            accounts: accounts.map((account) => getAddress(account)),
          })
        }
      },

      onChainChanged(chain) {
        config.emitter.emit('change', { chainId: Number(chain) })
      },

      onDisconnect() {
        parameters.keyring.lock()
        config.emitter.emit('disconnect')
      },
    }
  })
}
