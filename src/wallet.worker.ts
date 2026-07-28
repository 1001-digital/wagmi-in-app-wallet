import { WalletRuntime } from './runtime.js'
import type {
  WalletRuntimeMethod,
  WalletRuntimeRequestMap,
} from './types.js'

type WorkerRequest<M extends WalletRuntimeMethod = WalletRuntimeMethod> = {
  id: number
  method: M
  input: WalletRuntimeRequestMap[M]['input']
}

type WorkerResponse =
  | { id: number; ok: true; output: unknown }
  | { id: number; ok: false; error: { name: string; message: string } }

const runtime = new WalletRuntime()
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse): void
}

workerScope.onmessage = async ({ data }) => {
  try {
    const output = await runtime.request(
      data.method,
      data.input as never,
    )
    workerScope.postMessage({ id: data.id, ok: true, output })
  } catch (error) {
    workerScope.postMessage({
      id: data.id,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : 'Wallet operation failed',
      },
    })
  }
}
