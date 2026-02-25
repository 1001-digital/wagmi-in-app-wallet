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
  connectors: [inAppWallet()],
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

### `prepareInAppWallet(mnemonic)`

Derives a private key from a BIP39 mnemonic, stores it in localStorage, and returns the wallet address. Call this before connecting.

### `InAppWalletParameters`

```ts
type InAppWalletParameters = {
  storageKey?: string
}
```

## License

MIT
