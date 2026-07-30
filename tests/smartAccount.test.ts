import { describe, expect, it } from 'vitest'
import {
  SIMPLE_7702_ACCOUNT_V08_IMPLEMENTATION,
  UnexpectedDelegationError,
  assertExpectedDelegation,
  getDelegationState,
  pimlicoUserOperationFees,
  toCallsStatus,
} from '../src/smartAccount'

describe('getDelegationState', () => {
  it('recognizes an undelegated EOA', () => {
    expect(getDelegationState()).toEqual({ status: 'undelegated' })
    expect(getDelegationState('0x')).toEqual({ status: 'undelegated' })
  })

  it('extracts an EIP-7702 implementation', () => {
    const code =
      `0xef0100${SIMPLE_7702_ACCOUNT_V08_IMPLEMENTATION.slice(2)}` as const
    expect(getDelegationState(code)).toEqual({
      status: 'delegated',
      implementation: SIMPLE_7702_ACCOUNT_V08_IMPLEMENTATION,
    })
  })

  it('rejects arbitrary account code', () => {
    expect(getDelegationState('0x60006000')).toEqual({
      status: 'invalid',
      code: '0x60006000',
    })
  })
})

describe('assertExpectedDelegation', () => {
  it('allows no delegation and the configured implementation', () => {
    expect(() =>
      assertExpectedDelegation(
        { status: 'undelegated' },
        SIMPLE_7702_ACCOUNT_V08_IMPLEMENTATION,
      ),
    ).not.toThrow()
    expect(() =>
      assertExpectedDelegation(
        {
          status: 'delegated',
          implementation: SIMPLE_7702_ACCOUNT_V08_IMPLEMENTATION,
        },
        SIMPLE_7702_ACCOUNT_V08_IMPLEMENTATION,
      ),
    ).not.toThrow()
  })

  it('refuses to overwrite a different delegation', () => {
    expect(() =>
      assertExpectedDelegation(
        {
          status: 'delegated',
          implementation: '0x0000000000000000000000000000000000000001',
        },
        SIMPLE_7702_ACCOUNT_V08_IMPLEMENTATION,
      ),
    ).toThrow(UnexpectedDelegationError)
  })
})

describe('toCallsStatus', () => {
  it('maps missing receipts to pending', () => {
    expect(toCallsStatus('0x01', 1, null)).toMatchObject({
      chainId: '0x1',
      status: 100,
      receipts: [],
    })
  })

  it('maps successful and failed UserOperations', () => {
    const transactionReceipt = { transactionHash: '0x02' }
    expect(
      toCallsStatus('0x01', 1, {
        success: true,
        receipt: transactionReceipt,
      }),
    ).toMatchObject({ status: 200, receipts: [transactionReceipt] })
    expect(
      toCallsStatus('0x01', 1, {
        success: false,
        receipt: transactionReceipt,
      }),
    ).toMatchObject({ status: 500, receipts: [transactionReceipt] })
  })
})

describe('pimlicoUserOperationFees', () => {
  it('uses Pimlico fast fees', () => {
    expect(
      pimlicoUserOperationFees({
        fast: {
          maxFeePerGas: '0x2a',
          maxPriorityFeePerGas: '0x20',
        },
      }),
    ).toEqual({
      maxFeePerGas: 42n,
      maxPriorityFeePerGas: 32n,
    })
  })

  it('rejects missing and invalid fees', () => {
    expect(() => pimlicoUserOperationFees({})).toThrow(
      'Pimlico did not return a fast UserOperation gas price',
    )
    expect(() =>
      pimlicoUserOperationFees({
        fast: {
          maxFeePerGas: '0x1',
          maxPriorityFeePerGas: '0x2',
        },
      }),
    ).toThrow('Pimlico returned an invalid UserOperation gas price')
  })
})
