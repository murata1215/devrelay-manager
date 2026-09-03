/**
 * manager 会話サーフェス v1 のルートコンポーネント（サイクル1.18 ④-2）。
 *
 * スレ選択は URL ハッシュ #thread=<id> で保持する。選択中スレに非終端状態の
 * Dispatch が1件でもあれば4秒間隔でポーリングし、スレ切替でタイマーをリセットする。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.js';
import { ApiError } from './api.js';
import type { ThreadDto, MessageDto, DispatchDto, CoreProjectDto } from './types.js';
import { parseThreadHash, formatThreadHash } from './lib/thread-hash.js';
import { shouldPoll } from './lib/dispatch-status.js';
import { ThreadList } from './components/ThreadList.js';
import { Timeline } from './components/Timeline.js';
import { Composer } from './components/Composer.js';
import { ProjectPicker } from './components/ProjectPicker.js';

const POLL_INTERVAL_MS = 4000;

export function App() {
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [projects, setProjects] = useState<CoreProjectDto[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => parseThreadHash(location.hash));
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [dispatches, setDispatches] = useState<DispatchDto[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [busyDispatchId, setBusyDispatchId] = useState<string | null>(null);
  const [sendDisabled, setSendDisabled] = useState(false);
  // サイクル1.23: 768px 未満でサイドバーを開閉するための state（レイアウト再構成のみ、他ロジックには影響しない）。
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /** fetch 失敗を画面上部の1行エラーへ反映する（コンソールに握り潰さない）。 */
  const reportError = useCallback((err: unknown) => {
    const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
    setErrorMessage(message);
  }, []);

  // 初回ロード: スレッド一覧・プロジェクト一覧。
  useEffect(() => {
    api.listThreads().then(setThreads).catch(reportError);
    api.listProjects().then(setProjects).catch(reportError);
  }, [reportError]);

  // ブラウザの戻る/進むでハッシュが変わった場合に追随する。
  useEffect(() => {
    function onHashChange() {
      setSelectedThreadId(parseThreadHash(location.hash));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  /** 選択中スレのメッセージ・Dispatch を読み直す。 */
  const reload = useCallback(
    async (threadId: string) => {
      try {
        const [nextMessages, nextDispatches] = await Promise.all([
          api.listMessages(threadId),
          api.listDispatches(threadId),
        ]);
        setMessages(nextMessages);
        setDispatches(nextDispatches);
      } catch (err) {
        // dispatch worker が off の場合 /dispatches が404になりうる。messages だけは出す。
        if (err instanceof ApiError && err.status === 404) {
          try {
            setMessages(await api.listMessages(threadId));
            setDispatches([]);
          } catch (innerErr) {
            reportError(innerErr);
          }
          return;
        }
        reportError(err);
      }
    },
    [reportError]
  );

  // スレ切替: 初回読み込み + ポーリングタイマーのリセット。
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (!selectedThreadId) {
      setMessages([]);
      setDispatches([]);
      return;
    }
    void reload(selectedThreadId);
  }, [selectedThreadId, reload]);

  // ポーリング: 非終端 Dispatch が1件でもあれば4秒間隔で再取得する。
  useEffect(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (!selectedThreadId || !shouldPoll(dispatches)) {
      return;
    }
    pollTimerRef.current = setInterval(() => {
      void reload(selectedThreadId);
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    // dispatches 自体の中身ではなく shouldPoll の結果でのみ張り直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId, shouldPoll(dispatches)]);

  function handleSelectThread(threadId: string) {
    location.hash = formatThreadHash(threadId);
    setSelectedThreadId(threadId);
  }

  async function handleCreateThread(title: string) {
    try {
      const thread = await api.createThread(title);
      setThreads((prev) => [thread, ...prev]);
      handleSelectThread(thread.id);
    } catch (err) {
      reportError(err);
    }
  }

  async function handleSend(content: string, council: boolean) {
    if (!selectedThreadId) {
      return;
    }
    setSendDisabled(true);
    try {
      try {
        await api.orchestrate(selectedThreadId, content, selectedProjectIds, council);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          // orchestrate 未提供（DISPATCH_WORKER_MODE=off）。メッセージのみ記録する。
          await api.createMessage(selectedThreadId, 'user', content);
          setInfoMessage('orchestrate は未提供です（DISPATCH_WORKER_MODE=off）。メッセージのみ記録しました。');
        } else {
          throw err;
        }
      }
      await reload(selectedThreadId);
    } catch (err) {
      reportError(err);
    } finally {
      setSendDisabled(false);
    }
  }

  const selectedThread = threads.find((t) => t.id === selectedThreadId) ?? null;

  return (
    <div className="flex flex-col h-dvh bg-bg text-text font-sans">
      <header className="flex items-center gap-3 h-11 px-4 border-b border-border bg-surface shrink-0">
        <button
          type="button"
          className="md:hidden inline-flex items-center justify-center w-8 h-8 -ml-1 rounded-sm text-muted hover:bg-bg hover:text-text"
          aria-label="スレッド一覧を開閉"
          onClick={() => setSidebarOpen((v) => !v)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <span className="font-semibold truncate">{selectedThread ? selectedThread.title : 'DevRelay Manager'}</span>
        <a
          className="ml-auto shrink-0 text-sm text-accent hover:underline"
          href="https://app.devrelay.io"
          target="_blank"
          rel="noreferrer"
        >
          app に切替
        </a>
      </header>

      {errorMessage && (
        <div
          className="px-4 py-1.5 text-sm cursor-pointer bg-danger/10 text-danger"
          onClick={() => setErrorMessage(null)}
        >
          {errorMessage}
        </div>
      )}
      {infoMessage && (
        <div
          className="px-4 py-1.5 text-sm cursor-pointer bg-accent/10 text-accent"
          onClick={() => setInfoMessage(null)}
        >
          {infoMessage}
        </div>
      )}

      <div className="flex flex-1 min-h-0 relative">
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-10 bg-black/30 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <div
          className={
            'w-[260px] shrink-0 border-r border-border bg-surface ' +
            'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:top-11 max-md:z-20 max-md:transition-transform ' +
            (sidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full')
          }
        >
          <ThreadList
            threads={threads}
            selectedThreadId={selectedThreadId}
            onSelect={(threadId) => {
              handleSelectThread(threadId);
              setSidebarOpen(false);
            }}
            onCreate={handleCreateThread}
          />
        </div>

        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto">
            <div className="min-h-full flex flex-col justify-end max-w-3xl mx-auto px-6 py-6">
              {selectedThreadId ? (
                <Timeline
                  messages={messages}
                  dispatches={dispatches}
                  projects={projects}
                  busyDispatchId={busyDispatchId}
                  onBusyChange={(id, busy) => setBusyDispatchId(busy ? id : null)}
                  onDispatchChanged={() => void reload(selectedThreadId)}
                  onError={(msg) => setErrorMessage(msg)}
                  onInfo={(msg) => setInfoMessage(msg)}
                />
              ) : (
                <div className="m-auto text-muted text-center py-16">
                  左のスレッド一覧から選択するか、新規スレッドを作成してください。
                </div>
              )}
            </div>
          </div>

          <div className="max-w-3xl mx-auto w-full px-6 pb-6 shrink-0">
            <ProjectPicker projects={projects} selectedIds={selectedProjectIds} onChange={setSelectedProjectIds} />
            <Composer disabled={!selectedThreadId || sendDisabled} onSend={handleSend} />
          </div>
        </div>
      </div>
    </div>
  );
}
