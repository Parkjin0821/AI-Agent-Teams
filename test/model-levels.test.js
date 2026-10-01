import test from 'node:test';
import assert from 'node:assert/strict';
import { levelChoice, levelFor } from '../src/model-levels.js';

const codex = [{ id: 'gpt-6-astra', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-6.1-sol', isDefault: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-6-luna', isDefault: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }];
const pick = (team, profile, failures = 0, executor = 'claude-code') => {
  const level = levelFor({ team, profile, failures });
  return [level.id, ...Object.values(levelChoice(executor, level, { codexModels: codex }) ?? {})];
};

test('제어팀: simple work gets a light model, complex or risky work a deeper one', () => {
  assert.deepEqual(pick('dev', { complexity: 'simple', risk: 'low' }), ['light', 'claude-sonnet-5-5', 'high']);
  assert.deepEqual(pick('dev', { complexity: 'normal', risk: 'normal' }), ['normal', 'claude-sonnet-5-5', 'xhigh']);
  assert.deepEqual(pick('dev', { complexity: 'complex', risk: 'normal' }), ['deep', 'claude-opus-5-5', 'high']);
  assert.deepEqual(pick('dev', { complexity: 'simple', risk: 'high' }), ['deep', 'claude-opus-5-5', 'high'], 'risk lifts even simple work');
  assert.deepEqual(pick('plan', null), ['normal', 'claude-sonnet-5-5', 'xhigh'], 'before the first plan');
});

test('teams that judge work never go below "보통"; repeated failure moves one level up, at most to the top', () => {
  assert.deepEqual(pick('qa', { complexity: 'simple', risk: 'low' }), ['normal', 'claude-sonnet-5-5', 'xhigh']);
  assert.deepEqual(pick('security', { complexity: 'simple', risk: 'low' }, 0, 'codex'), ['normal', 'gpt-6-luna', 'high']);
  assert.deepEqual(pick('dev', { complexity: 'simple', risk: 'low' }, 2), ['normal', 'claude-sonnet-5-5', 'xhigh']);
  assert.deepEqual(pick('dev', { complexity: 'complex', risk: 'high' }, 3), ['max', 'claude-fable-5-1', 'high']);
  assert.match(levelFor({ team: 'dev', profile: { complexity: 'complex', risk: 'high' }, failures: 3 }).why, /복잡한 작업 · 진전 없음·실패 3번/);
});

test('Codex: Luna (medium–high) for easy and normal work, Sol (low–medium) for hard work, never Astra on its own', () => {
  for (const n of [0, 1, 2, 3]) for (const f of [0, 3]) {
    const c = levelChoice('codex', levelFor({ team: 'dev', profile: { complexity: ['simple', 'normal', 'complex', 'complex'][n], risk: 'normal' }, failures: f }), { codexModels: codex });
    assert.ok(c.model === 'gpt-6-luna' ? ['medium', 'high'].includes(c.effort) : c.model === 'gpt-6.1-sol' && ['low', 'medium'].includes(c.effort), JSON.stringify(c));
  }
  assert.deepEqual(pick('dev', { complexity: 'simple', risk: 'low' }, 0, 'codex'), ['light', 'gpt-6-luna', 'medium']);
  assert.deepEqual(pick('qa', { complexity: 'complex', risk: 'normal' }, 0, 'codex'), ['deep', 'gpt-6.1-sol', 'low']);
  assert.deepEqual(pick('dev', { complexity: 'complex', risk: 'high' }, 3, 'codex'), ['max', 'gpt-6.1-sol', 'medium']);
  for (const n of [0, 1, 2, 3]) for (const f of [0, 3]) assert.notEqual(levelChoice('codex', levelFor({ team: 'dev', profile: { complexity: ['simple', 'normal', 'complex', 'complex'][n], risk: 'normal' }, failures: f }), { codexModels: codex })?.model, 'gpt-6-astra');
  // a listed level closest to the wanted one, lighter side first
  assert.deepEqual(levelChoice('codex', levelFor({ team: 'dev', profile: { complexity: 'complex' }, failures: 3 }), { codexModels: [{ id: 'gpt-6.1-sol', efforts: ['low', 'high'] }] }), { model: 'gpt-6.1-sol', effort: 'low' });
  assert.equal(levelChoice('codex', levelFor({ team: 'qa' }), { codexModels: [] }), null, 'an unknown list gives no choice');
});

test('나눠 쓰기: the first design step of a goal sets the direction on the deep level; later fixes as usual', async () => {
  const { levelFor } = await import('../src/model-levels.js');
  const simple = { complexity: 'simple', risk: 'low' };
  const first = levelFor({ team: 'design', profile: simple, firstDesign: true });
  assert.deepEqual([first.id, first.claude.model], ['deep', 'claude-opus-5-5']);
  assert.match(first.why, /첫 디자인/);
  assert.equal(levelFor({ team: 'design', profile: simple }).id, 'light', 'a later design step');
  assert.equal(levelFor({ team: 'dev', profile: simple, firstDesign: true }).id, 'light', 'only the design team');
  assert.equal(levelFor({ team: 'design', profile: simple, firstDesign: true, failures: 3 }).id, 'max', 'failures still raise it');
});
