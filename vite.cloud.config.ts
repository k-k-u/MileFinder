import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sites } from '@openai/sites-vite-plugin'

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= 'false'
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs'
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry'
  const { cloudflare } = await import('@cloudflare/vite-plugin')
  return {
    plugins: [react(), sites(), cloudflare({
      viteEnvironment: { name: 'server' },
      config: {
        name: 'milefinder',
        main: './server/cloudWorker.ts',
        compatibility_date: '2026-09-22',
        assets: { binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
        d1_databases: [{ binding: 'DB', database_name: 'milefinder-local', database_id: '00000000-0000-4000-8000-000000000000' }],
      },
    })],
  }
})
