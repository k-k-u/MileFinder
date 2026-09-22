import { createServer, request } from 'node:http'
import { afterEach, expect, test, vi } from 'vitest'
import { createMemberWorkerConfig, PUBLIC_SITE_ORIGIN } from './memberWorkerConfig'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())) })
function send(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request(url, { method: 'POST', headers }, res => {
      let body = ''
      res.setEncoding('utf8'); res.on('data', part => { body += part })
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
    })
    req.on('error', reject); req.end()
  })
}

test('管理キーはloopbackかつ同一OriginのJSON POSTだけに返す', async () => {
  const getConfig = vi.fn(async () => ({ apiOrigin: PUBLIC_SITE_ORIGIN, token: 'test-only-management-key' }))
  const handler = createMemberWorkerConfig(getConfig)
  const server = createServer((req, res) => { void handler(req, res, () => { res.writeHead(404); res.end() }) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/api/member-worker/local-config`
  const headers = { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
  for (const overrides of [{ origin: 'https://evil.example' }, { host: 'evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await send(url, { ...headers, ...overrides })
    expect(response.status).toBe(403)
    expect(response.body).not.toContain('test-only-management-key')
  }
  expect(getConfig).not.toHaveBeenCalled()
  const response = await send(url, headers)
  expect(response.status).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(JSON.parse(response.body)).toEqual({ apiOrigin: PUBLIC_SITE_ORIGIN, token: 'test-only-management-key' })
  expect(getConfig).toHaveBeenCalledTimes(1)
})
