import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // Bundled separately: entry for the LLM inference utilityProcess.
          llmWorker: resolve('src/llm-worker/index.ts')
        }
      }
    }
  },
  preload: {
    // zod is bundled, not externalized: the preload imports the IPC contract
    // for its runtime channel allowlist, and a sandboxed preload cannot
    // require() external node modules.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })]
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
