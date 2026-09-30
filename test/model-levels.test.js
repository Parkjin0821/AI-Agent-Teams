import test from 'node:test';
import assert from 'node:assert/strict';
import { levelChoice, levelFor } from '../src/model-levels.js';

const codex = [{ id: 'gpt-6-astra', isDefault: true, efforts: ['low', 'medium', 'high', 'ultra'] }, { id: 'gpt-5.5', isDefault: false, efforts: ['low', 'medium', 'high'] }];
const pick = (team, profile, failures = 0, executor = 'claude-code') => {
  const level = levelFor({ team, profile, failures });
  return [level.id, ...Object.values(levelChoice(executor, level, { codexModels: codex }) ?? {})];
};

test('제어팀: simple work gets a light model, complex or risky work a deeper one', () => {
  assert.deepEqual(pick('dev', { complexity: 'simple', risk: 'low' }), ['light', 'claude-sonnet-5-5', 'low']);
  assert.deepEqual(pick('dev', { complexity: 'normal', risk: 'normal' }), ['normal', 'claude-sonnet-5-5', 'medium']);
  assert.deepEqual(pick('dev', { complexity: 'complex', risk: 'normal' }), ['deep', 'claude-opus-5-5', 'high']);
  assert.deepEqual(pick('dev', { complexity: 'simple', risk: 'high' }), ['deep', 'claude-opus-5-5', 'high'], 'risk lifts even simple work');
  assert.deepEqual(pick('plan', null), ['normal', 'claude-sonnet-5-5', 'medium'], 'before the first plan');
});

test('teams that judge work never go below "보통"; repeated failure moves one level up, at most to the top', () => {
  assert.deepEqual(pick('qa', { complexity: 'simple', risk: 'low' }), ['normal', 'claude-sonnet-5-5', 'medium']);
  assert.deepEqual(pick('security', { complexity: 'simple', risk: 'low' }, 0, 'codex'), ['normal', 'gpt-6-astra', 'medium']);
  assert.deepEqual(pick('dev', { complexity: 'simple', risk: 'low' }, 2), ['normal', 'claude-sonnet-5-5', 'medium']);
  assert.deepEqual(pick('dev', { complexity: 'complex', risk: 'high' }, 3), ['max', 'claude-fable-5-1', 'high']);
  assert.match(levelFor({ team: 'dev', profile: { complexity: 'complex', risk: 'high' }, failures: 3 }).why, /복잡한 작업 · 진전 없음·실패 3번/);
});

test('Codex keeps its default model and takes the closest listed reasoning level; an unknown list gives no choice', () => {
  assert.deepEqual(pick('dev', { complexity: 'complex', risk: 'high' }, 3, 'codex'), ['max', 'gpt-6-astra', 'high'], 'xhigh is not listed: closest, lighter side');
  assert.equal(levelChoice('codex', levelFor({ team: 'qa' }), { codexModels: [] }), null);
});
