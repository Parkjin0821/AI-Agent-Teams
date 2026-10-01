import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectWorkspaces } from '../src/작업공간.js';

test('legacy ID folders migrate to project titles, keeping files and a stable persistent mapping', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-named-'));
  const old = new ProjectWorkspaces(root).resolve('p-one');
  writeFileSync(path.join(old, '결과.md'), '원본 그대로');
  const workspaces = new ProjectWorkspaces(root, { titleFor: () => '가계부 요약' });
  const named = workspaces.resolve('p-one');
  assert.equal(path.basename(named), '가계부 요약');
  assert.equal(existsSync(old), false);
  assert.equal(readFileSync(path.join(named, '결과.md'), 'utf8'), '원본 그대로');
  assert.equal(new ProjectWorkspaces(root).resolve('p-one'), named);
  assert.equal(workspaces.resolve('p-one'), named);
  const second = workspaces.resolve('p-two');
  assert.equal(path.basename(second), '가계부 요약 (2)');
  assert.equal(workspaces.remove('p-one'), true);
  assert.ok(existsSync(second));
});

test('busy legacy folders wait; mapped renames recover after interruption; invalid mappings fail closed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-named-'));
  const old = new ProjectWorkspaces(root).resolve('p-one');
  let busy = true;
  const workspaces = new ProjectWorkspaces(root, { titleFor: () => '회의록', canRename: () => !busy });
  assert.equal(workspaces.resolve('p-one'), old);
  busy = false;
  writeFileSync(path.join(root, '.프로젝트경로.json'), JSON.stringify({ 'p-one': '회의록' }));
  assert.equal(path.basename(workspaces.resolve('p-one')), '회의록');
  writeFileSync(path.join(root, '.프로젝트경로.json'), JSON.stringify({ 'p-one': '../외부' }));
  assert.throws(() => workspaces.resolve('p-one'), /Invalid workspace folder/);
  assert.throws(() => workspaces.remove('p-one'), /Invalid workspace folder/);
});

test('Windows-invalid titles, reserved names, prototype keys and unrelated folders stay safe', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-named-'));
  const workspaces = new ProjectWorkspaces(root, { titleFor: id => id === '__proto__' ? 'CON' : '../한글 : 문서/.' });
  assert.match(path.basename(workspaces.resolve('p-one')), /한글/);
  assert.equal(path.dirname(workspaces.resolve('p-one')), root);
  assert.equal(path.basename(workspaces.resolve('__proto__')), '프로젝트-CON');
  assert.equal(path.basename(new ProjectWorkspaces(root).resolve('__proto__')), '프로젝트-CON');
  const other = new ProjectWorkspaces(root, { titleFor: () => '한글 문서' });
  assert.equal(path.basename(other.resolve('p-two')), '한글 문서 (2)');
});

test('project workspaces are stable, distinct and cannot escape the root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-workspaces-'));
  const workspaces = new ProjectWorkspaces(root);
  const first = workspaces.resolve('project-one');
  assert.equal(workspaces.resolve('project-one'), first);
  assert.notEqual(workspaces.resolve('project-two'), first);
  assert.throws(() => workspaces.resolve('../outside'), /projectId/);
  assert.throws(() => workspaces.resolve('C:\\outside'), /projectId/);
  const external = mkdtempSync(path.join(tmpdir(), 'hq-external-'));
  symlinkSync(external, path.join(root, 'linked'), 'junction');
  assert.throws(() => workspaces.resolve('linked'), /link/);
});

test('removing a workspace deletes only that project folder and never follows a link', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-workspaces-'));
  const workspaces = new ProjectWorkspaces(root);
  const dir = workspaces.resolve('gone');
  writeFileSync(path.join(dir, 'f.txt'), 'x');
  assert.equal(workspaces.remove('gone'), true);
  assert.equal(existsSync(dir), false);
  assert.equal(workspaces.remove('gone'), false, 'nothing to remove');
  const external = mkdtempSync(path.join(tmpdir(), 'hq-external-'));
  writeFileSync(path.join(external, 'keep.txt'), 'x');
  symlinkSync(external, path.join(root, 'linked'), 'junction');
  assert.throws(() => workspaces.remove('linked'), /link/);
  assert.equal(existsSync(path.join(external, 'keep.txt')), true);
  assert.throws(() => workspaces.remove('../x'), /projectId/);
});

test('the projects root gets a package.json boundary so projects never inherit the AGENT HQ module type', async () => {
  const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'hq-bnd-'));
  new ProjectWorkspaces(dir);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).type, 'commonjs');
  writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs","mine":true}');
  new ProjectWorkspaces(dir);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).mine, true, 'an existing file is never overwritten');
});
