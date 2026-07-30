# @1001-digital/wagmi-in-app-wallet

A [wagmi](https://wagmi.sh) connector that turns a BIP39 mnemonic into a fully functional in-browser wallet. Keys are derived locally and stored in `localStorage` — no external signers or extensions required.

## Install

```sh
pnpm add @1001-digital/wagmi-in-app-wallet
```

`@wagmi/core` and `viem` are peer dependencies.

## Usage

```ts
import { inAppWallet, prepareInAppWallet } from '@1001-digital/wagmi-in-app-wallet'
import { createConfig, http } from '@wagmi/core'
import { mainnet } from 'viem/chains'

const config = createConfig({
  chains: [mainnet],
  connectors: [
    inAppWallet({
      smartAccounts: {
        [mainnet.id]: {
          // Point this at an authenticated application broker. Do not expose
          // a Pimlico API key in browser code.
          rpcUrl: 'https://api.example.com/11x11/smart-account/rpc',
          fetchOptions: { credentials: 'include' },
        },
      },
    }),
  ],
  transports: { [mainnet.id]: http() },
})

// Derive and store the private key from a mnemonic
await prepareInAppWallet('your twelve word mnemonic ...')

// Then connect
await config.connectors[0].connect()
```

### Custom storage key

```ts
inAppWallet({ storageKey: 'my-app:wallet-pk' })
```

## API

### `inAppWallet(parameters?)`

Creates a wagmi connector. Accepts an optional `InAppWalletParameters` object:

- `storageKey` — localStorage key for the private key (default: `evm:in-app-wallet-pk`)
- `smartAccounts` — optional per-chain EIP-7702/4337 configuration. Configured
  chains support `wallet_sendCalls`, `wallet_getCallsStatus`, and
  `wallet_getCapabilities`.

### `prepareInAppWallet(mnemonic)`

Derives a private key from a BIP39 mnemonic, stores it in localStorage, and returns the wallet address. Call this before connecting.

Disconnecting the connector preserves the generated key so the same wallet can
reconnect after a sign-out or page reload. Call `forgetInAppWallet()` only when
the user explicitly asks to remove the wallet from this browser.

### `InAppWalletParameters`

```ts
type InAppWalletParameters = {
  storageKey?: string
  smartAccounts?: Record<number, {
    rpcUrl: string
    entryPoint?: Address
    implementation?: Address
    paymasterContext?: unknown
    fetchOptions?: RequestInit
  }>
}
```

The first smart-account call signs the EIP-7702 authorization and includes it
in the sponsored UserOperation. Existing delegations are accepted only when
they match the configured implementation; a different delegation is never
overwritten automatically.

The smart-account RPC must expose Pimlico's
`pimlico_getUserOperationGasPrice` method. The connector uses its `fast` fee
tier when preparing and signing UserOperations, as recommended by Pimlico.

### `forgetInAppWallet(storageKey?)`

Explicitly removes the locally stored in-app wallet key. Ordinary connector
disconnects do not remove wallet material.

### `clearInAppWalletDelegation(parameters)`

Sends an explicit, self-paid EIP-7702 transaction that clears the current
delegation. This recovery action is never invoked automatically.

## License

MIT
