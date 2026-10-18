import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BundleRejected, checkReturnedPath, extractReturn, listNames, packFolder, tarHeader, unpackReturn } from '../src/작업묶음.js';

// 작업 묶음: what goes into the Codex distro and what may come back (docs/codex-격리-복원.md 2차 설계).
const temp = () => mkdtempSync(path.join(tmpdir(), 'hq-bundle-'));
function project(files) {
  const dir = temp();
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}
// A hand-made tar: [{ name, type, data }] (data '' for directories and links).
function craft(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    parts.push(tarHeader({ name: e.name, size: data.length, type: e.type ?? '0' }));
    if (data.length) parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

test('pack: only the project\'s own plain files go in — no .git, node_modules, secrets or agent config', () => {
  const longName = `${'아주긴이름'.repeat(12)}/결과 보고서.md`;
  const dir = project({ 'index.html': '<h1>hi</h1>', 'src/앱.js': 'x', [longName]: '긴 경로', 'img/a.bin': Buffer.from([0, 255, 1, 254]),
    '.git/config': 'x', 'node_modules/a/index.js': 'x', '.env': 'KEY=1', '.env.local': 'KEY=1', 'id_rsa': 'k', 'cert.pem': 'k',
    '.claude/settings.json': '{}', 'AGENTS.md': 'do evil', 'sub/CLAUDE.md': 'x' });
  try {
    const { tar, files, skipped } = packFolder(dir);
    assert.deepEqual(files.sort(), ['img/a.bin', 'index.html', longName, 'src/앱.js'].sort());
    assert.deepEqual(skipped.map(s => s.path).sort(), ['.claude', '.env', '.env.local', '.git', 'AGENTS.md', 'cert.pem', 'id_rsa', 'node_modules', 'sub/CLAUDE.md'].sort());
    const back = unpackReturn(tar);
    const byPath = Object.fromEntries(back.files.map(f => [f.path, f.data]));
    assert.equal(byPath[longName].toString('utf8'), '긴 경로');
    assert.deepEqual([...byPath['img/a.bin']], [0, 255, 1, 254]);
    assert.ok(back.dirs.includes('src'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pack: a link in the work folder stops the job instead of being followed', (t) => {
  const dir = project({ 'a.txt': 'x' }), outside = temp();
  try {
    try { symlinkSync(outside, path.join(dir, 'link'), 'junction'); } catch { t.skip('links cannot be made here'); return; }
    assert.throws(() => packFolder(dir), BundleRejected);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('pack: size and count limits', () => {
  const dir = project({ 'a.txt': 'x'.repeat(100), 'b.txt': 'y' });
  try {
    assert.throws(() => packFolder(dir, { limits: { maxFiles: 10, maxBytes: 1000, maxFileBytes: 50 } }), /너무 크다/);
    assert.throws(() => packFolder(dir, { limits: { maxFiles: 1, maxBytes: 1000, maxFileBytes: 1000 } }), /너무 많다/);
    assert.throws(() => packFolder(dir, { limits: { maxFiles: 10, maxBytes: 50, maxFileBytes: 1000 } }), /너무 크다/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('return: links, devices and paths that climb out are refused — one bad entry rejects the whole return', () => {
  const ok = { name: 'ok.txt', data: 'fine' };
  const bad = [
    [{ name: 'l', type: '2' }, /링크/],
    [{ name: 'h', type: '1' }, /링크/],
    [{ name: 'dev', type: '3' }, /일반 파일이 아니다/],
    [{ name: 'fifo', type: '6' }, /일반 파일이 아니다/],
    [{ name: '/etc/passwd', data: 'x' }, /경로/],
    [{ name: '../escape.txt', data: 'x' }, /경로/],
    [{ name: 'a/../../escape.txt', data: 'x' }, /경로/],
    [{ name: 'a\\..\\b.txt', data: 'x' }, /경로/],
    [{ name: 'C:/Windows/x.txt', data: 'x' }, /경로/],
    [{ name: 'AGENTS.md', data: 'x' }, /돌려받을 수 없는/],
    [{ name: 'deep/.claude/settings.json', data: '{}' }, /돌려받을 수 없는/],
    [{ name: '.git/hooks/pre-commit', data: 'x' }, /돌려받을 수 없는/],
    [{ name: 'node_modules/x.js', data: 'x' }, /돌려받을 수 없는/],
    [{ name: 'CON.txt', data: 'x' }, /Windows/],
    [{ name: 'trailing.', data: 'x' }, /Windows/],
  ];
  for (const [entry, why] of bad) {
    assert.throws(() => unpackReturn(craft([ok, entry])), e => e instanceof BundleRejected && why.test(e.message), entry.name);
  }
  assert.deepEqual(unpackReturn(craft([{ name: './', type: '5' }, ok])).files.map(f => f.path), ['ok.txt']);
});

test('return: an empty masked placeholder folder at the top is dropped; one with anything inside is refused', () => {
  const ok = { name: 'ok.txt', data: 'fine' };
  for (const p of ['.agents', '.codex', '.git', '.aws']) {
    assert.deepEqual(unpackReturn(craft([{ name: `./${p}/`, type: '5' }, ok])).files.map(f => f.path), ['ok.txt'], p);
    assert.throws(() => unpackReturn(craft([{ name: `./${p}/`, type: '5' }, { name: `./${p}/x`, data: 'x' }, ok])), BundleRejected, p);
  }
  assert.throws(() => unpackReturn(craft([{ name: 'sub/.codex/', type: '5' }, ok])), BundleRejected, 'only at the top');
  assert.deepEqual(listNames(craft([{ name: 'a', data: 'x' }, { name: 'l', type: '2' }])), ['0:a', '2:l']);
});

test('return: broken or oversized streams are refused', () => {
  const good = craft([{ name: 'a.txt', data: 'hello' }]);
  const tampered = Buffer.from(good); tampered[0] = 'b'.charCodeAt(0);
  assert.throws(() => unpackReturn(tampered), /검사합/);
  assert.throws(() => unpackReturn(good.subarray(0, 515)), /잘렸다/);
  assert.throws(() => unpackReturn(good.subarray(0, 1024)), /끝 표시 없음/);
  assert.throws(() => unpackReturn(craft([{ name: 'a', data: 'x'.repeat(20) }]), { limits: { maxFiles: 9, maxBytes: 99, maxFileBytes: 10 } }), /너무 크다/);
  assert.throws(() => unpackReturn(craft([{ name: 'a', data: 'x' }, { name: 'b', data: 'y' }]), { limits: { maxFiles: 1, maxBytes: 99, maxFileBytes: 10 } }), /너무 많다/);
});

test('return: GNU long names and pax paths are read; extraction stays inside the target', () => {
  const name = `${'d'.repeat(120)}/f.txt`;
  const tar = craft([{ name: '././@LongLink', type: 'L', data: `${name}\0` }, { name: 'short', data: 'gnu' }]);
  const back = unpackReturn(tar);
  assert.deepEqual(back.files.map(f => f.path), [name]);
  const out = temp();
  try {
    extractReturn(back, out);
    assert.equal(readFileSync(path.join(out, ...name.split('/')), 'utf8'), 'gnu');
    assert.throws(() => extractReturn({ files: [{ path: '../x', data: Buffer.from('') }], dirs: [] }, out), BundleRejected);
  } finally { rmSync(out, { recursive: true, force: true }); }
  assert.equal(checkReturnedPath('./a/b.txt'), 'a/b.txt');
  assert.equal(checkReturnedPath('./'), null);
});

// The distro side uses GNU tar; here Windows' own tar (bsdtar) checks that the format is the standard one.
const systemTar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
test('real tar reads what the engine packs, and the engine reads what real tar packs', { skip: !existsSync(systemTar) && 'tar 없음' }, () => {
  const longName = `${'보고서'.repeat(30)}/요약.md`;
  const dir = project({ 'a.txt': 'A', [longName]: '한글 내용', 'sub/b.bin': Buffer.from([1, 2, 3]) });
  const out = temp(), out2 = temp();
  try {
    const { tar } = packFolder(dir);
    const x = spawnSync(systemTar, ['-x', '-f', '-', '-C', out], { input: tar });
    assert.equal(x.status, 0, String(x.stderr));
    assert.equal(readFileSync(path.join(out, ...longName.split('/')), 'utf8'), '한글 내용');
    assert.deepEqual([...readFileSync(path.join(out, 'sub', 'b.bin'))], [1, 2, 3]);
    const c = spawnSync(systemTar, ['-c', '-f', '-', '--format', 'pax', '-C', dir, '.'], { maxBuffer: 64 * 1024 * 1024 });
    assert.equal(c.status, 0, String(c.stderr));
    const back = unpackReturn(c.stdout);
    extractReturn(back, out2);
    assert.equal(readFileSync(path.join(out2, ...longName.split('/')), 'utf8'), '한글 내용');
    assert.equal(readFileSync(path.join(out2, 'a.txt'), 'utf8'), 'A');
  } finally { for (const d of [dir, out, out2]) rmSync(d, { recursive: true, force: true }); }
});
