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
    <div className="project-picker">
      <div className="project-picker__title">
        プロジェクト選択（送信時のヒントになります・未選択でも送信可）
        <span className="project-picker__note">
          ※ ここでの選択は orchestrator LLM への選択ヒントです。実際の投げ先は承認カードで確定します。
        </span>
      </div>
      <input
        type="text"
        className="project-picker__search"
        placeholder="name / path / machine で絞り込み"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="project-picker__list">
        {projects.length === 0 && <span className="project-picker__empty">core に接続されたプロジェクトがありません</span>}
        {projects.length > 0 && visibleProjects.length === 0 && (
          <span className="project-picker__empty">条件に一致するプロジェクトがありません</span>
        )}
        {visibleProjects.map((project) => (
          <label key={project.id} className="project-picker__item">
            <input
              type="checkbox"
              checked={selectedIds.includes(project.id)}
              onChange={() => toggle(project.id)}
            />
            {project.name}
            {!project.online && <span className="project-picker__offline">（オフライン）</span>}
          </label>
        ))}
      </div>
    </div>
  );
}
