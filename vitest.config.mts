import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      exclude: ['dist/**', 'out/**', 'scripts/**', 'tests/**']
    }
  }
})
