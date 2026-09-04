/**
 * ログイントークンの保持・ハッシュからの受け取り・失効通知（サイクル1.27）。
 *
 * core は Bearer トークンのみでセッションを表す（Cookie は使わない）ため、保存先は
 * localStorage 一択とする。api.ts は 401/403 を受けたら clearToken() を呼び、購読者
 * （App.tsx）へ通知してサインイン画面へ戻す。
 */
import { parseTokenFromHash } from './lib/token-from-hash.js';

const TOKEN_KEY = 'manager_token';
const ERROR_KEY = 'manager_auth_error';

export type AuthClearReason = 'unauthorized' | 'forbidden';

const listeners = new Set<() => void>();

/** 保存済みトークンを読む。無ければ null。 */
export function readToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** トークンを保存する。ログイン成功時に呼ぶため、過去の認可エラー表示も消す。 */
export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.removeItem(ERROR_KEY);
}

/** トークンを消す。reason を残すことで SignIn 側が「拒否されました」等の文言を出せる。 */
export function clearToken(reason: AuthClearReason | null): void {
  localStorage.removeItem(TOKEN_KEY);
  if (reason) {
    localStorage.setItem(ERROR_KEY, reason);
  } else {
    localStorage.removeItem(ERROR_KEY);
  }
  for (const listener of listeners) {
    listener();
  }
}

/** 直近の認可エラー理由。 */
export function readAuthError(): AuthClearReason | null {
  const value = localStorage.getItem(ERROR_KEY);
  return value === 'unauthorized' || value === 'forbidden' ? value : null;
}

/**
 * clearToken() が呼ばれたら通知を受ける（App.tsx がサインイン画面へ戻すために使う）。
 * 戻り値の関数を呼ぶと購読解除する。
 */
export function onAuthCleared(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * 起動時1回呼ぶ。location.hash に #token=<hex64> があれば保存し、ハッシュを消す
 * （#thread= の hashchange リスナには影響しない — replaceState は hashchange を発火しない）。
 */
export function bootstrapTokenFromHash(): void {
  const token = parseTokenFromHash(location.hash);
  if (!token) {
    return;
  }
  saveToken(token);
  history.replaceState(null, '', location.pathname + location.search);
}
