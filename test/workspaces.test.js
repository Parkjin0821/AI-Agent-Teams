import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectWorkspaces } from '../src/workspaces.js';

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