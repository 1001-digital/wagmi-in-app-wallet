# @1001-digital/wagmi-in-app-wallet

A wagmi connector for a client-encrypted, host-synchronized EVM wallet.
Mnemonic and private-key material stay in a browser worker while the host stores
only a versioned AES-GCM vault.

## Install

```sh
pnpm add @1001-digital/wagmi-in-app-wallet
```

`@wagmi/core` and `viem` are peer dependencies.

## Usage

```ts
import {
  EncryptedWalletKeyring,
  inAppWallet,
  type WalletVaultStore,
} from '@1001-digital/wagmi-in-app-wallet'

const store: WalletVaultStore = {
  load: () => api.get('/me/vaults/evm-in-app-wallet'),
  put: (document, expectedRevision) =>
    api.put('/me/vaults/evm-in-app-wallet', {
      document,
      expectedRevision,
    }),
}

const keyring = new EncryptedWalletKeyring({ store })
await keyring.load()

const connector = inAppWallet({
  keyring,
  requestUnlock: async () => {
    await openUnlockDialog(keyring)
  },
})
```

Use `keyring.create({ passphrase, scope })` for a new 12-word wallet or
`keyring.restore({ mnemonic, passphrase, scope })` for recovery. A passphrase is
always retained as the portable recovery wrapper; supported WebAuthn passkeys can
be added as additional PRF-based wrappers.

Calling `disconnect()` or `keyring.lock()` destroys the in-memory signer. It does
not delete the synchronized encrypted vault.

## Security model

- The host API receives ciphertext, public address, salts, and wrapping metadata.
  It never receives a mnemonic, private key, passphrase, or WebAuthn PRF output.
- Passphrase keys use Argon2id. Vault and wrapped-key ciphertext use AES-256-GCM
  with domain-separated authenticated data.
- Browser reload, tab close, explicit lock, and sign-out require another unlock.
- A recovery phrase remains the user escape path if the host API or passkey
  provider becomes unavailable.
- JavaScript running in the page can still influence requests while the wallet is
  unlocked. Host applications must use a restrictive CSP and treat third-party
  scripts as part of the wallet trust boundary.

## License

MIT
