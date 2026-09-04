/**
 * URL ハッシュからログイントークンを取り出す（サイクル1.27）。
 *
 * `#token=<64桁hex>` の形のみを受理する。core からのリダイレクト先で受け取る想定。
 * `#thread=<id>`（thread-hash.ts）とは前置詞が異なるため排他的に扱える。
 * トークンが含まれるハッシュは「トークンとしてのみ」扱う（他の情報と混在させない）。
 */

const PREFIX = '#token=';
const HEX64_PATTERN = /^[0-9a-f]{64}$/i;

/** location.hash 相当の文字列からトークンを取り出す。形式が合わなければ null。 */
export function parseTokenFromHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) {
    return null;
  }
  const token = hash.slice(PREFIX.length);
  return HEX64_PATTERN.test(token) ? token : null;
}
