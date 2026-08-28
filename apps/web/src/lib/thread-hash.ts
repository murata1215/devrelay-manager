/**
 * スレ選択の URL ハッシュ保持（サイクル1.18 ④-2）。
 *
 * `#thread=<id>` の形でスレIDを保持し、リロードで復元できるようにする。
 */

const PREFIX = '#thread=';

/** location.hash 相当の文字列からスレIDを取り出す。形式が合わなければ null。 */
export function parseThreadHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) {
    return null;
  }
  const id = hash.slice(PREFIX.length);
  return id.length > 0 ? id : null;
}

/** スレIDから location.hash 相当の文字列を組み立てる。 */
export function formatThreadHash(threadId: string): string {
  return `${PREFIX}${threadId}`;
}
