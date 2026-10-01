import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SandboxRunner } from '../src/격리환경.js';

test('앱 업데이트 중 실행 파일이 사라지면 새 경로로 한 번만 재시도한다', async () => {
  const files = [];
  const runner = new SandboxRunner({ codex: { file: 'old', prefix: [] },
    resolve: () => ({ file: 'new', prefix: [] }), spawnFn(file) {
      files.push(file);
      const child = new EventEmitter();
      queueMicrotask(() => files.length === 1 ? child.emit('error', { code: 'ENOENT' }) : child.emit('close', 0));
      return child;
    } });
  assert.equal((await runner.run('.', ['node', '--version'])).status, 'pass');
  assert.deepEqual(files, ['old', 'new']);
});

test('재시도도 실행 파일이 없으면 종료하며 일반 실행 실패는 재시도하지 않는다', async () => {
  for (const missing of [true, false]) {
    let calls = 0;
    const runner = new SandboxRunner({ codex: { file: 'cli', prefix: [] }, resolve: () => ({ file: 'cli', prefix: [] }),
      spawnFn() {
        calls++;
        const child = new EventEmitter();
        queueMicrotask(() => missing ? child.emit('error', { code: 'ENOENT' }) : child.emit('close', 1));
        return child;
      } });
    assert.equal((await runner.run('.', ['node', '--version'])).status, missing ? 'unavailable' : 'fail');
    assert.equal(calls, missing ? 2 : 1);
  }
});
