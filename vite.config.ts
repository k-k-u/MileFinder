import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { anaAvailabilityPlugin } from './server/plugin'

export default defineConfig({
  plugins: [react(), anaAvailabilityPlugin()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  test: { include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
})
