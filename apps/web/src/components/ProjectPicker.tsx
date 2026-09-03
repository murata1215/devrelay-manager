/**
 * 下部: プロジェクト選択（サイクル1.25 要求C: 折りたたみ化）。
 *
 * 既定は1行（フィルタ入力＋選択中チップ＋「候補を表示」）に折りたたみ、
 * ポップオーバーで候補一覧を表示する。ポップオーバーは input 上方に配置し
 * （max-height 240px でスクロール）、DOM は本コンポーネント内に閉じる（portal は使わない）。
 * オフラインのプロジェクトは既定で非表示（トグルで表示）。
 *
 * サイクル1.19 S1 で orchestrate（POST /threads/:id/orchestrate）が
 * projectIds をヒントとして受け取れるようになったため、ここでの選択は
 * 実効的に orchestrator LLM への選択ヒントとして送信される（App.tsx の handleSend 参照）。
 * props インターフェースは変更しない。
 */
import { useState } from 'react';
import type { CoreProjectDto } from '../types.js';
import { filterProjects } from '../lib/project-filter.js';

interface ProjectPickerProps {
  projects: CoreProjectDto[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

const NOTE = 'ここでの選択は orchestrator LLM への選択ヒントです。実際の投げ先は承認カードで確定します。';

export function ProjectPicker({ projects, selectedIds, onChange }: ProjectPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [showOffline, setShowOffline] = useState(false);

  const filtered = filterProjects(projects, query);
  const visibleProjects = showOffline ? filtered : filtered.filter((p) => p.online);
  const selectedProjects = projects.filter((p) => selectedIds.includes(p.id));

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  }

  function remove(id: string) {
    onChange(selectedIds.filter((x) => x !== id));
  }

  return (
    <div className="relative mb-2" title={NOTE}>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="text"
          className="min-w-64 flex-1 rounded-sm border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none"
          placeholder="投げ先のヒント（未選択でも送信可）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
        />
        {selectedProjects.map((project) => (
          <span
            key={project.id}
            className="inline-flex items-center gap-1 rounded-full border border-accent bg-accent/10 px-2 py-0.5 text-xs text-text"
          >
            {project.name}
            <button
              type="button"
              className="text-muted hover:text-danger"
              aria-label={`${project.name} を選択解除`}
              onClick={() => remove(project.id)}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          className="ml-auto shrink-0 rounded-sm border border-border px-2 py-1 text-xs text-muted hover:text-text"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '候補を隠す' : '候補を表示'}
        </button>
      </div>

      {open && (
        <>
          {/* ポップオーバー外クリックで閉じるための透明バックドロップ。portal は使わず本コンポーネント内に留める。 */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-1 max-h-60 w-72 overflow-y-auto rounded-sm border border-border bg-surface p-2">
            <label className="mb-1.5 flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={showOffline} onChange={(e) => setShowOffline(e.target.checked)} />
              オフラインも表示
            </label>
            <div className="flex flex-col gap-1">
              {projects.length === 0 && (
                <span className="text-xs text-muted">core に接続されたプロジェクトがありません</span>
              )}
              {projects.length > 0 && visibleProjects.length === 0 && (
                <span className="text-xs text-muted">条件に一致するプロジェクトがありません</span>
              )}
              {visibleProjects.map((project) => {
                const selected = selectedIds.includes(project.id);
                return (
                  <label
                    key={project.id}
                    className={
                      'flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs ' +
                      (selected ? 'bg-accent/10 text-text' : 'text-muted hover:text-text')
                    }
                  >
                    <input type="checkbox" checked={selected} onChange={() => toggle(project.id)} />
                    {project.name}
                    {!project.online && <span className="text-danger">（オフライン）</span>}
                  </label>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
