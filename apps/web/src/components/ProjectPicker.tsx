/**
 * 下部: プロジェクト複数選択（チェックボックス列）。
 *
 * 【注意】orchestrate（POST /threads/:id/orchestrate）はプロジェクト選択を
 * body に受け取る口を持たない（apps/server/src/routes/orchestrator.ts のスキーマ確認済み）。
 * ここでの選択は UI 上のヒント表示に留まり、送信内容には反映されない。
 */
import type { CoreProjectDto } from '../types.js';

interface ProjectPickerProps {
  projects: CoreProjectDto[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

export function ProjectPicker({ projects, selectedIds, onChange }: ProjectPickerProps) {
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
        プロジェクト選択（ヒント表示のみ・未選択でも送信可）
        <span className="project-picker__note">
          ※ orchestrate API はプロジェクト選択を受け取りません。実際の投げ先は orchestrator LLM が推定し、承認カードで確定します。
        </span>
      </div>
      <div className="project-picker__list">
        {projects.length === 0 && <span className="project-picker__empty">core に接続されたプロジェクトがありません</span>}
        {projects.map((project) => (
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
