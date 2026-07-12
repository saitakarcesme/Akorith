import react from '@vitejs/plugin-react-swc'
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    extends: './vitest.config.mts',
    test: {
      name: 'unit',
      environment: 'node',
      include: ['tests/unit/**/*.test.ts']
    }
  },
  {
    extends: './vitest.config.mts',
    test: {
      name: 'integration',
      environment: 'node',
      include: ['tests/integration/**/*.test.ts']
    }
  },
  {
    extends: './vitest.config.mts',
    plugins: [react()],
    test: {
      name: 'component',
      environment: 'jsdom',
      include: ['tests/component/**/*.test.tsx'],
      setupFiles: ['./tests/setup/component.ts']
    }
  }
])
