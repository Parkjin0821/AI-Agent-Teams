import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Built-in checks the engine runs itself over the project folder. They only read files, need nothing
// installed, and report where a problem is — never the secret or personal value itself.
const SKIP_DIRS = ['.git', 'node_modules', '.venv', '__pycache__'];
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|md|txt|html?|css|scss|py|env|ya?ml|toml|ini|cfg|conf|sh|ps1|bat|sql|csv|xml|svg|vue|svelte|rb|go|rs|java|kt|php|properties)$/i;
const MAX_FILE = 1_000_000;

export function textFiles(cwd, { max = 400 } = {}) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) return;
      if (SKIP_DIRS.includes(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (TEXT_EXT.test(entry.name) || /^\.env/.test(entry.name)) && statSync(full).size <= MAX_FILE) {
        out.push(path.relative(cwd, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(cwd);
  return out;
}

const read = (cwd, rel) => { try { return readFileSync(path.join(cwd, rel), 'utf8'); } catch { return ''; } };

function scan(cwd, patterns, { files = textFiles(cwd), maxFindings = 30 } = {}) {
  const findings = [];
  for (const rel of files) {
    const lines = read(cwd, rel).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { kind, re, skip } of patterns) {
        if (findings.length >= maxFindings) return;
        if (re.test(line) && !(skip && skip.test(line))) findings.push({ file: rel, line: i + 1, kind });
      }
    });
  }
  return findings;
}

// Secret formats published by the providers themselves, plus hard-coded password/key assignments.
const SECRET_PATTERNS = [
  { kind: '개인 키 (PEM)', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/ },
  { kind: 'AWS 액세스 키', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'GitHub 토큰', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { kind: 'Anthropic API 키', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'OpenAI API 키', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/, skip: /sk-ant-/ },
  { kind: 'Slack 토큰', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'Google API 키', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: '코드에 적힌 비밀번호·키', re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
    skip: /process\.env|os\.environ|getenv|example|placeholder|your[_-]|xxx|\*\*\*|<[^>]+>/i },
];

export function scanSecrets(cwd) {
  const files = textFiles(cwd);
  const findings = scan(cwd, SECRET_PATTERNS, { files });
  // A committed .env file is a secret store even if its values look harmless.
  for (const rel of files) {
    if (/(^|\/)\.env(\.[^/]*)?$/.test(rel) && !/\.(example|sample|template)$/.test(rel)) findings.push({ file: rel, line: null, kind: '.env 파일' });
  }
  return { files: files.length, findings };
}

// Personal data that must not be stored or published without a decision.
const PRIVACY_PATTERNS = [
  { kind: '주민등록번호 형식', re: /\b\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])-?[1-4]\d{6}\b/, strong: true },
  { kind: '카드번호 형식', re: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2})[- ]?\d{4}[- ]?\d{4}[- ]?\d{3,4}\b/, strong: true },
  { kind: '휴대전화번호', re: /\b01[016789]-?\d{3,4}-?\d{4}\b/ },
  { kind: '이메일 주소', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, skip: /@(example\.(com|org|net)|test\.com|localhost)\b|noreply@/i },
];

// Scan the exact frozen export bytes, not a second reading of a changing workspace.
export function inspectExport(files) {
  const findings = [];
  for (const file of files) for (const line of file.content.split(/\r?\n/)) {
    for (const pattern of [...SECRET_PATTERNS, ...PRIVACY_PATTERNS]) {
      if (pattern.re.test(line) && !(pattern.skip && pattern.skip.test(line))) findings.push({ file: file.path, kind: pattern.kind });
    }
  }
  return findings.slice(0, 30);
}

export function scanPrivacy(cwd) {
  const findings = scan(cwd, PRIVACY_PATTERNS);
  const strong = new Set(PRIVACY_PATTERNS.filter(p => p.strong).map(p => p.kind));
  return { findings: findings.map(f => ({ ...f, strong: strong.has(f.kind) })) };
}

// Licences of npm dependencies as declared in their installed package.json. Copyleft needs 대장's call.
const COPYLEFT = /\b(A?GPL|LGPL|SSPL|EUPL|OSL|CC-BY-(NC|SA|ND))/i;
export function licenseReport(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'));
  const project = pkg?.license ?? (['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find(f => existsSync(path.join(cwd, f))) ? 'LICENSE 파일' : null);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const packages = Object.keys(deps).slice(0, 200).map((name) => {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) return { name, license: '이름 확인 불가', flag: 'unknown' };
    const installed = readJson(path.join(cwd, 'node_modules', ...name.split('/'), 'package.json'));
    const license = typeof installed?.license === 'string' ? installed.license : installed?.license?.type ?? null;
    return { name, license: license ?? (installed ? '표기 없음' : '설치 안 됨 · 확인 불가'),
      flag: !license ? 'unknown' : COPYLEFT.test(license) ? 'copyleft' : 'ok' };
  });
  const python = existsSync(path.join(cwd, 'requirements.txt'))
    ? read(cwd, 'requirements.txt').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean).slice(0, 100) : [];
  return { project, packages, python };
}

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

// Basic accessibility and hygiene of HTML pages the team made.
export function checkHtml(cwd) {
  const pages = textFiles(cwd).filter(f => /\.html?$/i.test(f)).slice(0, 20);
  return {
    pages: pages.map((rel) => {
      const html = read(cwd, rel);
      const issues = [];
      if (!/<title>[^<]+<\/title>/i.test(html)) issues.push('<title> 없음');
      if (!/<html[^>]*\blang=/i.test(html)) issues.push('<html lang> 없음');
      if (!/<meta[^>]+name=["']viewport["']/i.test(html)) issues.push('모바일 viewport 설정 없음');
      const noAlt = (html.match(/<img\b(?![^>]*\balt=)[^>]*>/gi) ?? []).length;
      if (noAlt) issues.push(`alt 없는 이미지 ${noAlt}개`);
      const external = [...new Set([...html.matchAll(/<script[^>]+src=["']https?:\/\/([^/"']+)/gi)].map(m => m[1]))];
      if (external.length) issues.push(`외부 스크립트: ${external.join(', ')}`);
      return { file: rel, issues };
    }),
  };
}

// Research notes must carry their sources: every Markdown file under research/ needs links and a date.
export function checkSources(cwd) {
  const notes = textFiles(cwd).filter(f => /^research\/.+\.md$/i.test(f)).slice(0, 50);
  return {
    notes: notes.map((rel) => {
      const text = read(cwd, rel);
      const links = new Set(text.match(/https?:\/\/[^\s)>\]"']+/g) ?? []).size;
      const dated = /\b20\d{2}[-./년]\s?\d{1,2}([-./월]\s?\d{1,2})?/.test(text);
      return { file: rel, links, dated };
    }),
  };
}

// Which test command fits the project. Only these fixed commands are ever run, inside the sandbox.
export function detectTests(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'));
  const script = pkg?.scripts?.test;
  if (typeof script === 'string' && script.trim() && !/no test specified/.test(script)) return { runner: 'npm', label: 'npm test' };
  const files = textFiles(cwd);
  if (files.some(f => /(^|\/)(test|tests|__tests__)\/.+\.(c|m)?js$|\.test\.(c|m)?js$/.test(f))) return { runner: 'node', label: 'node --test' };
  if (files.some(f => /(^|\/)test_[^/]+\.py$|_test\.py$/.test(f))) return { runner: 'python', label: 'python -m unittest' };
  return null;
}
