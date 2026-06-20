import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
// SWC handles the React/TSX transform instead of esbuild — faster, and avoids
// esbuild's transform worker hanging in restricted/sandboxed build environments.
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
})
