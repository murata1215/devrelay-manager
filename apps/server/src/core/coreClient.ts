/**
 * manager → core 接続アダプタ。
 *
 * core が提供する MCP（Model Context Protocol）サーバーを localhost 経由で再利用する。
 * manager は core の機能を再実装せず、常にこのアダプタ越しに参照する（doc/web-manager-surface-concept.md §8 準拠）。
 *
 * 接続先はステートレスな StreamableHTTP エンドポイントのため、Mcp-Session-Id は扱わない。
 * 認証は DEVRELAY_PAT を Bearer トークンとしてリクエストヘッダに付与する。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildSubmitInstructionArgs } from './submit-args.js';

const CLIENT_NAME = 'devrelay-manager';
const CLIENT_VERSION = '0.1.0';

let clientPromise: Promise<Client> | null = null;

function getCoreMcpUrl(): string {
  return process.env.CORE_MCP_URL ?? 'http://127.0.0.1:3005/mcp';
}

function getPat(): string {
  const pat = process.env.DEVRELAY_PAT;
  if (!pat || pat.trim() === '') {
    // PAT・接続文字列自体はエラーメッセージに含めない
    throw new Error(
      'DEVRELAY_PAT が未設定です。apps/server/.env に DEVRELAY_PAT を設定してください。'
    );
  }
  return pat;
}

async function connect(): Promise<Client> {
  const url = new URL(getCoreMcpUrl());
  const pat = getPat();

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${pat}`,
      },
    },
  });

  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });

  try {
    await client.connect(transport);
  } catch (err) {
    throw classifyConnectError(err);
  }

  return client;
}

/** 接続エラーを原因が分かる形に分類する（PAT・URL 自体はメッセージに含めない）。 */
function classifyConnectError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes('401') || message.toLowerCase().includes('unauthorized')) {
    return new Error(
      'core MCP への認証に失敗しました（401）。DEVRELAY_PAT が無効か期限切れの可能性があります。'
    );
  }
  if (
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND') ||
    message.includes('ETIMEDOUT') ||
    message.includes('fetch failed')
  ) {
    return new Error(
      'core MCP へ到達できませんでした。CORE_MCP_URL・core プロセスの起動状態を確認してください。'
    );
  }
  return new Error(`core MCP への接続でエラーが発生しました: ${message}`);
}

/** 遅延シングルトン。接続済みクライアントを再利用し、切断が疑われる場合は再接続する。 */
async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect();
  }
  try {
    return await clientPromise;
  } catch (err) {
    // 接続自体に失敗した場合は次回呼び出しで再試行できるようにリセットする
    clientPromise = null;
    throw err;
  }
}

/** MCP ツールを呼び出し、content[0].text を JSON として返す共通ヘルパ。 */
async function callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const client = await getClient();

  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (err) {
    // ツール呼び出し自体が失敗（接続断など）した場合は再接続できるようリセット
    clientPromise = null;
    throw classifyConnectError(err);
  }

  if (result.isError) {
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    throw new Error(`core ツール「${name}」がエラーを返しました: ${text || '(詳細不明)'}`);
  }

  const content = Array.isArray(result.content) ? result.content : [];
  const textEntry = content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
  if (!textEntry) {
    throw new Error(`core ツール「${name}」の応答に text コンテンツがありません。`);
  }

  try {
    return JSON.parse(textEntry.text) as T;
  } catch {
    throw new Error(`core ツール「${name}」の応答が JSON として解釈できません。`);
  }
}

export interface CoreProject {
  id: string;
  name: string;
  path: string;
  machine: string;
  machineId: string;
  online: boolean;
  aiTool: string;
}

interface ListProjectsResult {
  projects: CoreProject[];
}

export interface SubmitInstructionResult {
  submissionId: string;
  status: string;
}

export interface GetPlanResult {
  status: string;
  // 実測（サイクル1.8 ③-2）: not_found 応答には planMarkdown/executable が無い。
  // 必須と宣言していたのは誤りだった（manager 側アダプタの型修正。core は変更しない）。
  planMarkdown?: string;
  executable?: boolean;
  [key: string]: unknown;
}

export interface ApproveImplementationResult {
  phase: string;
}

export interface GetBuildStatusResult {
  phase?: string;
  // 実測: 存在しない submissionId でも {"phase":"queued","done":false} が返り、
  // buildId/summary は含まれない。必須と宣言していたのは誤りだった。
  buildId?: string;
  summary?: string;
  done: boolean;
  // サイクル1.19 S4/S5: devlog パスを core が実際に返すかは未確認（型の実態合わせのみ）。
  devlogPath?: string;
}

/** core が把握している全プロジェクトを取得する（online フラグ含む）。 */
export async function listProjects(): Promise<CoreProject[]> {
  const result = await callTool<ListProjectsResult>('list_projects', {});
  return result.projects;
}

/**
 * 対象プロジェクトへ指示を投入する。
 *
 * サイクル1.21: council は「claude↔codex の協議を有効化する」オプトイン。
 * 【重要・実測】core の submit_instruction は現時点で council を受け取らない
 * （tools/list の inputSchema は projectId/instruction のみ）。council が true でも
 * 未知引数として core に静かに捨てられ、submit 自体は成功する（実測確認済み）。
 * 引数組み立ては submit-args.ts の純関数へ切り出してあり、未指定/false のときは
 * 従来と完全同形の呼び出しになる。
 */
export async function submitInstruction(
  projectId: string,
  instruction: string,
  council?: boolean
): Promise<SubmitInstructionResult> {
  return callTool<SubmitInstructionResult>(
    'submit_instruction',
    buildSubmitInstructionArgs(projectId, instruction, council)
  );
}

/** submission に紐づくプランを取得する。 */
export async function getPlan(submissionId: string): Promise<GetPlanResult> {
  return callTool<GetPlanResult>('get_plan', { submissionId });
}

/**
 * プランを承認し実装フェーズへ進める。
 *
 * サイクル1.19 S3: note は「案B/案C」等の人間からの自由記述を core へ伝えるチャネル。
 * core が未知引数 note を拒否する可能性を排除できないため、note が明示された時だけ
 * args に note キー自体を含める（未指定時は現行と完全同形の呼び出しを保つ）。
 */
export async function approveImplementation(
  projectId: string,
  submissionId: string,
  note?: string
): Promise<ApproveImplementationResult> {
  const args: Record<string, unknown> = { projectId, submissionId };
  if (note !== undefined) {
    args.note = note;
  }
  return callTool<ApproveImplementationResult>('approve_implementation', args);
}

/** ビルド状況を取得する。 */
export async function getBuildStatus(submissionId: string): Promise<GetBuildStatusResult> {
  return callTool<GetBuildStatusResult>('get_build_status', { submissionId });
}
