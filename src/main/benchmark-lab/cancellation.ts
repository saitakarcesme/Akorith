export type BenchmarkAbortCode = 'cancelled' | 'timed_out'

export class BenchmarkAbortError extends Error {
  constructor(readonly code: BenchmarkAbortCode, message: string) {
    super(message)
    this.name = 'BenchmarkAbortError'
  }
}

export interface BenchmarkAbortScope {
  signal: AbortSignal
  dispose(): void
  classify(error: unknown): BenchmarkAbortError | null
}

/** Link a caller cancellation signal to a bounded fixture timeout. */
export function createBenchmarkAbortScope(parent: AbortSignal, timeoutMs: number): BenchmarkAbortScope {
  const controller = new AbortController()
  let cause: BenchmarkAbortCode | null = null
  const cancel = (): void => {
    cause = 'cancelled'
    controller.abort(parent.reason ?? new BenchmarkAbortError('cancelled', 'Benchmark run was cancelled.'))
  }
  if (parent.aborted) cancel()
  else parent.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => {
    cause = 'timed_out'
    controller.abort(new BenchmarkAbortError('timed_out', `Benchmark fixture exceeded ${timeoutMs} ms.`))
  }, timeoutMs)
  timer.unref?.()

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent.removeEventListener('abort', cancel)
    },
    classify(error) {
      if (!controller.signal.aborted && !(error instanceof BenchmarkAbortError)) return null
      if (error instanceof BenchmarkAbortError) return error
      if (controller.signal.reason instanceof BenchmarkAbortError) return controller.signal.reason
      const code = cause ?? (parent.aborted ? 'cancelled' : 'timed_out')
      return new BenchmarkAbortError(code, code === 'cancelled' ? 'Benchmark run was cancelled.' : `Benchmark fixture exceeded ${timeoutMs} ms.`)
    }
  }
}

export function throwIfBenchmarkAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new BenchmarkAbortError('cancelled', 'Benchmark run was cancelled.')
}

/** Enforce the boundary even when a faulty adapter neglects the AbortSignal. */
export async function raceBenchmarkAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfBenchmarkAborted(signal)
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new BenchmarkAbortError('cancelled', 'Benchmark run was cancelled.'))
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}
