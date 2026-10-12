export class RequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    throw new RequestError('ログインの期限が切れた可能性があります。ページを再読み込みしてログインしてください。', response.status || 401);
  }
  const data = await response.json();
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error : '処理に失敗しました。';
    throw new RequestError(message, response.status);
  }
  return data as T;
}
export function errorMessage(error: unknown) {
  return error instanceof RequestError ? error.message : '通信できません。接続を確認して再試行してください。';
}
// Safari 15 には crypto.randomUUID がないため、getRandomValues で操作 ID を作る。
export function operationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
