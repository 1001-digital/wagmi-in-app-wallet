import { WalletRuntime } from './runtime.js'
import type {
  WalletRuntimeClient,
  WalletRuntimeMethod,
  WalletRuntimeRequestMap,
} from './types.js'

class InlineRuntimeClient implements WalletRuntimeClient {
  readonly #runtime = new WalletRuntime()

  request<M extends WalletRuntimeMethod>(
    method: M,
    input: WalletRuntimeRequestMap[M]['input'],
  ): Promise<WalletRuntimeRequestMap[M]['output']> {
    return this.#runtime.request(method, input)
  }

  destroy(): void {
    this.#runtime.lock()
  }
}

class WorkerRuntimeClient implements WalletRuntimeClient {
  readonly #worker: Worker
  #nextId = 1
  readonly #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >()
  #failure: Error | null = null

  constructor() {
    this.#worker = new Worker(new URL('./wallet.worker.ts', import.meta.url), {
      type: 'module',
      name: 'in-app-wallet',
    })
    this.#worker.onmessage = (
      event: MessageEvent<
        | { id: number; ok: true; output: unknown }
        | { id: number; ok: false; error: { name: string; message: string } }
      >,
    ) => {
      const pending = this.#pending.get(event.data.id)
      if (!pending) return
      this.#pending.delete(event.data.id)
      if (event.data.ok) {
        pending.resolve(event.data.output)
        return
      }
      const error = new Error(event.data.error.message)
      error.name = event.data.error.name
      pending.reject(error)
    }
    this.#worker.onerror = () => {
      this.#failure = new Error('Wallet worker failed')
      for (const pending of this.#pending.values()) {
        pending.reject(this.#failure)
      }
      this.#pending.clear()
    }
  }

  request<M extends WalletRuntimeMethod>(
    method: M,
    input: WalletRuntimeRequestMap[M]['input'],
  ): Promise<WalletRuntimeRequestMap[M]['output']> {
    if (this.#failure) return Promise.reject(this.#failure)
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#worker.postMessage({ id, method, input })
    })
  }

  destroy(): void {
    this.#worker.terminate()
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('Wallet worker terminated'))
    }
    this.#pending.clear()
  }
}

export function createWalletRuntimeClient(): WalletRuntimeClient {
  if (typeof window === 'undefined') return new InlineRuntimeClient()
  if (typeof Worker === 'undefined') {
    throw new Error('A module Worker is required for the in-app wallet')
  }
  return new WorkerRuntimeClient()
}
