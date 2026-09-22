import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'

const runFile = promisify(execFile)
export const PUBLIC_SITE_ORIGIN = 'https://milefinder-ana-awards.raisin7524.chatgpt.site'
type WorkerConfig = { apiOrigin: string; token: string }

/** Windowsの現在の利用者で暗号化した管理キー。ANAの認証情報は扱わない。 */
async function localWorkerConfig(): Promise<WorkerConfig> {
  const path = resolve('.milefinder-worker-token.encrypted.local')
  await readFile(path, 'utf8')
  if (process.platform !== 'win32') throw new Error('unsupported')
  const literal = path.replaceAll("'", "''")
  const script = `$ErrorActionPreference='Stop'; $key=(Get-Content -LiteralPath '${literal}' -Raw).Trim() | ConvertTo-SecureString; $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($key); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }`
  // PowerShell 7由来のmodule pathをWindows PowerShellへ持ち込まない。
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: environment, windowsHide: true, timeout: 5000, maxBuffer: 4096 })
  const token = stdout.trim()
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('invalid')
  return { apiOrigin: PUBLIC_SITE_ORIGIN, token }
}

export function createMemberWorkerConfig(getConfig: () => Promise<WorkerConfig> = localWorkerConfig) {
  return async function memberWorkerConfig(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (req.url !== '/api/member-worker/local-config') return next()
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(JSON.stringify(value))
    }
    const host = req.headers.host ?? ''
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
      || !/^(127\.0\.0\.1|localhost):5173$/.test(host) || req.headers.origin !== `http://${host}`
      || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return reply(403, { error: '管理PCのローカル画面だけで利用できます。' })
    if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return reply(405, { error: '対応していない要求です。' })
    try { reply(200, await getConfig()) }
    catch { reply(503, { error: '管理用の接続キーを自動取得できません。手入力してください。' }) }
  }
}
