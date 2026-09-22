/** Cloudflare固有パッケージに依存しない、使用するD1機能だけの型。 */
export interface D1Result { success: boolean; meta: { changes?: number }; results?: unknown[] }
export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>
  run(): Promise<D1Result>
}
export interface D1Database {
  prepare(sql: string): D1Statement
  batch(statements: D1Statement[]): Promise<D1Result[]>
}
export interface CloudEnv {
  DB: D1Database
  MEMBER_WORKER_TOKEN: string
  ASSETS?: { fetch(request: Request): Promise<Response> }
}
