/**
 * 下部: プロジェクト複数選択（チェックボックス列）。
 *
 * サイクル1.19 S1 で orchestrate（POST /threads/:id/orchestrate）が
 * projectIds をヒントとして受け取れるようになったため、ここでの選択は
 * 実効的に orchestrator LLM への選択ヒントとして送信される（App.tsx の handleSend 参照）。
 * サイクル1.19 W3: name/path/machine の部分一致で絞り込む検索欄を追加する。
 */
import { useState } from 'react';
import type { CoreProjectDto } from '../types.js';
import { filterProjects } from '../lib/project-filter.js';

interface ProjectPickerProps {
  projects: CoreProjectDto[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

export function ProjectPicker({ projects, selectedIds, onChange }: ProjectPickerProps) {
  const [query, setQuery] = useState('');
  const visibleProjects = filterProjects(projects, query);

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  }

  return (
    <div className="mb-2">
      <div className="text-xs text-muted mb-1.5">
        プロジェクト選択（送信時のヒントになります・未選択でも送信可）
        <span className="block text-muted/80">
          ※ ここでの選択は orchestrator LLM への選択ヒントです。実際の投げ先は承認カードで確定します。
        </span>
      </div>
      <input
        type="text"
        className="block w-full max-w-xs mb-2 rounded-sm border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-muted focus:outline-none focus:border-accent"
        placeholder="name / path / machine で絞り込み"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="flex flex-wrap gap-1.5">
        {projects.length === 0 && <span className="text-muted text-xs">core に接続されたプロジェクトがありません</span>}
        {projects.length > 0 && visibleProjects.length === 0 && (
          <span className="text-muted text-xs">条件に一致するプロジェクトがありません</span>
        )}
        {visibleProjects.map((project) => {
          const selected = selectedIds.includes(project.id);
          return (
            <label
              key={project.id}
              className={
                'inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-xs cursor-pointer ' +
                (selected ? 'bg-accent/10 border-accent text-text' : 'border-border text-muted hover:text-text')
              }
            >
              <input
                type="checkbox"
                className="accent-[var(--color-accent)]"
                checked={selected}
                onChange={() => toggle(project.id)}
              />
              {project.name}
              {!project.online && <span className="text-danger">（オフライン）</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}
