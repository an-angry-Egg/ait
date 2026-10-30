export type Profile = {
  name: string
  email: string
  phone: string
  avatar: string
  role: string
}

export type LoginRecord = {
  time: string
  ip: string
  device: string
  place: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function traceId(): string {
  const rand = Math.random().toString(16).slice(2, 10)
  return 'tr-' + rand
}

/**
 * 真实项目里 trace id 通常由请求库统一注入。这里保持同样形态，
 * 便于之后由扩展拦截请求、把 trace id 与画圈目标关联起来。
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  headers.set('x-ait-trace-id', traceId())

  const res = await fetch(path, { ...init, headers })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { message: text }
  }

  if (!res.ok) {
    throw new ApiError(res.status, data?.message ?? `请求失败（${res.status}）`)
  }
  return data as T
}

export function getProfile(): Promise<Profile> {
  return request<Profile>('/api/user/profile')
}

export function saveProfile(payload: { name: string; email: string }): Promise<Profile> {
  return request<Profile>('/api/user/profile', {
    method: 'PUT',
    body: JSON.stringify(payload)
  })
}

export function getLoginHistory(): Promise<LoginRecord[]> {
  return request<LoginRecord[]>('/api/user/login-history')
}

export function logout(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
}
