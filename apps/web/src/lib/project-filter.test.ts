import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterProjects } from './project-filter.js';
import type { CoreProjectDto } from '../types.js';

function projects(): CoreProjectDto[] {
  return [
    {
      id: 'proj-1',
      name: 'pixblog',
      path: '/srv/pixblog',
      machine: 'ubuntu-prod',
      machineId: 'm1',
      online: true,
      aiTool: 'claude',
    },
    {
      id: 'proj-2',
      name: 'pixdraft',
      path: '/srv/pixdraft',
      machine: 'mac-mini',
      machineId: 'm2',
      online: false,
      aiTool: 'claude',
    },
  ];
}

test('17. filterProjects: 空クエリ（空文字・空白のみ）は全件を返す', () => {
  assert.equal(filterProjects(projects(), '').length, 2);
  assert.equal(filterProjects(projects(), '   ').length, 2);
});

test('18. filterProjects: name/path/machine の部分一致・大文字小文字無視で絞り込む', () => {
  assert.deepEqual(
    filterProjects(projects(), 'PIXBLOG').map((p) => p.id),
    ['proj-1']
  );
  assert.deepEqual(
    filterProjects(projects(), '/srv/pixdraft').map((p) => p.id),
    ['proj-2']
  );
  assert.deepEqual(
    filterProjects(projects(), 'MAC-MINI').map((p) => p.id),
    ['proj-2']
  );
  assert.deepEqual(filterProjects(projects(), 'no-match').length, 0);
});
