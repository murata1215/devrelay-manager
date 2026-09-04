/**
 * 未ログイン時のサインイン画面（サイクル1.27）。
 *
 * manager 自身はログインフォームを持たない — core の /login にリダイレクトし、
 * core 側のログイン完了後に #token=<hex> 付きで manager に戻ってくる想定。
 */
import type { AuthClearReason } from '../auth.js';

const CORE_WEB_URL = (import.meta.env.VITE_CORE_WEB_URL as string | undefined) ?? 'https://app.devrelay.io';

interface SignInProps {
  reason: AuthClearReason | null;
}

export function SignIn({ reason }: SignInProps) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg text-text">
      <div className="text-lg font-semibold">DevRelay Manager</div>
      {reason === 'forbidden' && (
        <div className="max-w-sm text-center text-sm text-danger">
          このアカウントは manager の利用を許可されていません
        </div>
      )}
      <button
        type="button"
        className="inline-flex items-center justify-center rounded-sm bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        onClick={() => {
          location.href = `${CORE_WEB_URL}/login?next=manager`;
        }}
      >
        DevRelay でログイン
      </button>
    </div>
  );
}
