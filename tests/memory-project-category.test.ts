import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectCategoryFromRemote,
  resolveProjectMemoryCategory,
} from '../src/memory_system/projectCategory.ts';

test('projectCategoryFromRemote normalizes HTTPS git remotes', () => {
  assert.equal(
    projectCategoryFromRemote('https://github.com/m13rix/acn1.0.git'),
    'project:github.com/m13rix/acn1.0',
  );
});

test('projectCategoryFromRemote normalizes SSH git remotes', () => {
  assert.equal(
    projectCategoryFromRemote('git@github.com:m13rix/acn1.0.git'),
    'project:github.com/m13rix/acn1.0',
  );
  assert.equal(
    projectCategoryFromRemote('ssh://git@github.com/m13rix/acn1.0.git'),
    'project:github.com/m13rix/acn1.0',
  );
});

test('resolveProjectMemoryCategory uses explicit category strings directly', () => {
  assert.equal(
    resolveProjectMemoryCategory('Project:Custom/Name'),
    'project:custom/name',
  );
});

test('resolveProjectMemoryCategory falls back to project directory name without a remote', () => {
  assert.equal(
    resolveProjectMemoryCategory(true, {
      projectRoot: 'G:\\agent0\\local-only-project',
      gitRemoteUrl: null,
    }),
    'project:local-only-project',
  );
});
