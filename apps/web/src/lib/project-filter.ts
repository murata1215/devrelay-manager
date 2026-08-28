/**
 * プロジェクト選択の検索絞り込み（サイクル1.19 W3）。
 *
 * name / path / machine の部分一致（大文字小文字無視）。空クエリは全件を返す。
 */
import type { CoreProjectDto } from '../types.js';

/** query で projects を絞り込む。空クエリ（trim後空文字）は全件を返す。 */
export function filterProjects(projects: CoreProjectDto[], query: string): CoreProjectDto[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') {
    return projects;
  }
  return projects.filter((p) => {
    return (
      p.name.toLowerCase().includes(trimmed) ||
      p.path.toLowerCase().includes(trimmed) ||
      p.machine.toLowerCase().includes(trimmed)
    );
  });
}
