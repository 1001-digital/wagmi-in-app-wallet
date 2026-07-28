export class WalletLockedError extends Error {
  override name = 'WalletLockedError'

  constructor(message = 'The in-app wallet is locked') {
    super(message)
  }
}

export class VaultConflictError extends Error {
  override name = 'VaultConflictError'

  constructor(message = 'The wallet vault changed on another device') {
    super(message)
  }
}

export class VaultIntegrityError extends Error {
  override name = 'VaultIntegrityError'

  constructor(message = 'The encrypted wallet vault could not be verified') {
    super(message)
  }
}

export class PasskeyPrfUnavailableError extends Error {
  override name = 'PasskeyPrfUnavailableError'

  constructor() {
    super('This browser or passkey does not support encrypted vault unlock')
  }
}
