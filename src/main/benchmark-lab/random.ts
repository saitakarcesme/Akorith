/** Stable FNV-1a + avalanche hash used only for reproducible benchmark ordering. */
export function deriveBenchmarkSeed(baseSeed: number, ...parts: readonly string[]): number {
  let hash = (baseSeed >>> 0) || 0x811c9dc5
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0xff
    hash = Math.imul(hash, 0x85ebca6b) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d) >>> 0
  hash ^= hash >>> 15
  return hash >>> 0
}

export function createBenchmarkRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

export function deterministicShuffle<T>(values: readonly T[], seed: number): T[] {
  const shuffled = [...values]
  const random = createBenchmarkRandom(seed)
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]]
  }
  return shuffled
}
