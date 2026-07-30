import {
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type Transport,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddressEqual,
  numberToHex,
  zeroAddress,
} from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import {
  createBundlerClient,
  toSimple7702SmartAccount,
} from 'viem/account-abstraction'

export const ENTRY_POINT_V08_ADDRESS =
  '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' as const

export const SIMPLE_7702_ACCOUNT_V08_IMPLEMENTATION =
  '0xe6Cae83BdE06E4c305530e199D7217f42808555B' as const

const DELEGATION_DESIGNATOR_PREFIX = '0xef0100'

export type SmartAccountChainParameters = {
  rpcUrl: string
  entryPoint?: Address
  implementation?: Address
  paymasterContext?: unknown
  fetchOptions?: RequestInit
}

export type WalletCall = {
  to: Address
  data?: Hex
  value?: Hex
}

export type WalletSendCallsRequest = {
  atomicRequired?: boolean
  calls: readonly WalletCall[]
  chainId?: Hex
  from?: Address
  version?: string
}

export type DelegationState =
  | { status: 'undelegated' }
  | { status: 'delegated'; implementation: Address }
  | { status: 'invalid'; code: Hex }

export class UnexpectedDelegationError extends Error {
  readonly actual?: Address
  readonly expected: Address

  constructor(expected: Address, actual?: Address) {
    super(
      actual
        ? `Wallet is delegated to ${actual}, expected ${expected}`
        : 'Wallet has unsupported account code',
    )
    this.name = 'UnexpectedDelegationError'
    this.actual = actual
    this.expected = expected
  }
}

export function getDelegationState(code?: Hex): DelegationState {
  if (!code || code === '0x') return { status: 'undelegated' }

  if (
    code.length === 48 &&
    code.toLowerCase().startsWith(DELEGATION_DESIGNATOR_PREFIX)
  ) {
    return {
      status: 'delegated',
      implementation: getAddress(`0x${code.slice(8)}`),
    }
  }

  return { status: 'invalid', code }
}

export function assertExpectedDelegation(
  state: DelegationState,
  implementation: Address,
) {
  if (state.status === 'undelegated') return
  if (
    state.status === 'delegated' &&
    isAddressEqual(state.implementation, implementation)
  )
    return
  throw new UnexpectedDelegationError(
    implementation,
    state.status === 'delegated' ? state.implementation : undefined,
  )
}

export function toCallsStatus(
  id: string,
  chainId: number,
  receipt: Record<string, unknown> | null,
) {
  if (!receipt) {
    return {
      atomic: true,
      chainId: numberToHex(chainId),
      id,
      receipts: [],
      status: 100,
      version: '2.0.0',
    }
  }

  const success = receipt.success === true
  const transactionReceipt = receipt.receipt

  return {
    atomic: true,
    chainId: numberToHex(chainId),
    id,
    receipts:
      transactionReceipt &&
      typeof transactionReceipt === 'object' &&
      !Array.isArray(transactionReceipt)
        ? [transactionReceipt]
        : [],
    status: success ? 200 : 500,
    version: '2.0.0',
  }
}

export async function sendSmartAccountCalls(parameters: {
  account: PrivateKeyAccount
  calls: readonly WalletCall[]
  chain: Chain
  transport: Transport
  smartAccount: SmartAccountChainParameters
}): Promise<Hash> {
  const { account, calls, chain, transport, smartAccount } = parameters
  if (calls.length === 0) throw new Error('At least one call is required')

  const implementation = getAddress(
    smartAccount.implementation ??
      SIMPLE_7702_ACCOUNT_V08_IMPLEMENTATION,
  )
  const publicClient = createPublicClient({ chain, transport })
  const delegation = getDelegationState(
    await publicClient.getCode({ address: account.address }),
  )
  assertExpectedDelegation(delegation, implementation)

  const entryPoint = getAddress(
    smartAccount.entryPoint ?? ENTRY_POINT_V08_ADDRESS,
  )
  const smartAccountClient = await toSimple7702SmartAccount({
    client: publicClient,
    entryPoint: {
      abi: (
        await import('viem/account-abstraction')
      ).entryPoint08Abi,
      address: entryPoint,
      version: '0.8',
    },
    implementation,
    owner: account,
  })
  const bundlerClient = createBundlerClient({
    account: smartAccountClient,
    chain,
    client: publicClient,
    paymaster: true,
    paymasterContext: smartAccount.paymasterContext,
    transport: http(smartAccount.rpcUrl, {
      fetchOptions: smartAccount.fetchOptions,
    }),
  })

  const authorization =
    delegation.status === 'undelegated'
      ? await account.signAuthorization({
          chainId: chain.id,
          contractAddress: implementation,
          nonce: await publicClient.getTransactionCount({
            address: account.address,
            blockTag: 'pending',
          }),
        })
      : undefined

  return bundlerClient.sendUserOperation({
    account: smartAccountClient,
    authorization,
    calls: calls.map((call) => ({
      data: call.data,
      to: getAddress(call.to),
      value: call.value ? BigInt(call.value) : undefined,
    })),
  })
}

export async function getSmartAccountCallsStatus(parameters: {
  chain: Chain
  id: Hash
  smartAccount: SmartAccountChainParameters
}) {
  const { chain, id, smartAccount } = parameters
  const client = createBundlerClient({
    chain,
    transport: http(smartAccount.rpcUrl, {
      fetchOptions: smartAccount.fetchOptions,
    }),
  })
  const receipt = await client.request({
    method: 'eth_getUserOperationReceipt',
    params: [id],
  })

  return toCallsStatus(
    id,
    chain.id,
    receipt as Record<string, unknown> | null,
  )
}

export async function clearInAppWalletDelegation(parameters: {
  account: PrivateKeyAccount
  chain: Chain
  transport: Transport
}): Promise<Hash> {
  const { account, chain, transport } = parameters
  const publicClient = createPublicClient({ chain, transport })
  const delegation = getDelegationState(
    await publicClient.getCode({ address: account.address }),
  )
  if (delegation.status === 'undelegated')
    throw new Error('Wallet is not delegated')
  if (delegation.status === 'invalid')
    throw new Error('Wallet has unsupported account code')

  const walletClient = createWalletClient({ account, chain, transport })
  const authorization = await walletClient.signAuthorization({
    account,
    contractAddress: zeroAddress,
    executor: 'self',
  })

  return walletClient.sendTransaction({
    account,
    authorizationList: [authorization],
    chain,
    data: '0x',
    to: account.address,
    type: 'eip7702',
    value: 0n,
  })
}
