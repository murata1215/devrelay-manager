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

  async function handleSend(content: string) {
    if (!selectedThreadId) {
      return;
    }
    setSendDisabled(true);
    try {
      try {
        await api.orchestrate(selectedThreadId, content, selectedProjectIds);
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
    <div className="app">
      <header className="app__topbar">
        <a className="app__switch" href="https://app.devrelay.io" target="_blank" rel="noreferrer">
          app に切替
        </a>
        <span className="app__title">{selectedThread ? selectedThread.title : 'DevRelay Manager'}</span>
        <span className="app__topbar-right" />
      </header>

      {errorMessage && (
        <div className="app__error" onClick={() => setErrorMessage(null)}>
          {errorMessage}
        </div>
      )}
      {infoMessage && (
        <div className="app__info" onClick={() => setInfoMessage(null)}>
          {infoMessage}
        </div>
      )}

      <div className="app__body">
        <ThreadList
          threads={threads}
          selectedThreadId={selectedThreadId}
          onSelect={handleSelectThread}
          onCreate={handleCreateThread}
        />

        <div className="app__main">
          <div className="app__timeline">
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
              <div className="timeline timeline--empty">左のスレッド一覧から選択するか、新規スレッドを作成してください。</div>
            )}
          </div>

          <Composer disabled={!selectedThreadId || sendDisabled} onSend={handleSend} />

          <ProjectPicker projects={projects} selectedIds={selectedProjectIds} onChange={setSelectedProjectIds} />
        </div>
      </div>
    </div>
  );
}
