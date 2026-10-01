import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { granted } from './승인.js';
import { ruleFor } from './규칙.js';

// 감시 에이전트 (Sentinel): a separate program Claude Code calls before every tool use (official
// PreToolUse hook). It decides from fixed rules, not from a model, so text on a web page or in a file
// cannot talk it out of a decision. Allowed calls get no answer (Claude Code's own permission rules
// still apply); blocked calls end with exit code 2, which Claude Code always honours.
// Every decision on an outward or file-changing action is logged without secret values.

const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}/, /\bsk-ant-[A-Za-z0-9_-]{20,}/, /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];
export const hasSecret = text => typeof text === 'string' && SECRET.some(re => re.test(text));
export const FORBIDDEN_NAMES = /^(\.claude|\.codex|\.mcp\.json|CLAUDE(\.local)?\.md|AGENTS(\.override)?\.md|\.env(\..+)?|\.git)$/i;
const RISKY_CONNECTOR = /(delete|remove|trash|share|publish|send|invite|transfer|purchase|payment|pay_|checkout|upload_to|post_)/i;
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
export const READ_TOOLS = ['Read', 'Glob', 'Grep'];

function privateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes('.') || /(^|\.)(localhost|local|internal|lan|home|corp)$/.test(h)) return true;
  if (isIP(h)) return true; // any literal address: the rules cannot tell what is behind it
  return false;
}

// Returns { decision: 'allow' | 'ask' | 'deny' | 'ignore', reason, target, ask? } for one tool call.
// 'ask' = not allowed yet, becomes an approval request for 대장 (see src/승인.js).
// webMode 'ask': a public site needs a grant first; 'open': any public https site passes the fixed rules.
export function decide(input, { workspace, grants = [], project = null, webMode = 'open', now = Date.now(), rules = [], lane = null, laneDeny = [] } = {}) {
  const tool = String(input?.tool_name ?? '');
  const args = input?.tool_input ?? {};
  if (tool === 'WebFetch') {
    let url;
    try { url = new URL(String(args.url ?? '')); } catch { return { decision: 'deny', reason: '주소 형식이 잘못됨', target: '' }; }
    const target = `${url.hostname}${url.pathname}`.slice(0, 120);
    if (url.protocol !== 'https:') return { decision: 'deny', reason: 'https 가 아닌 주소', target };
    if (url.username || url.password) return { decision: 'deny', reason: '주소에 계정 정보가 들어 있음', target };
    if (privateHost(url.hostname)) return { decision: 'deny', reason: '내부·로컬 주소는 열 수 없음 (이 컴퓨터와 내부망 보호)', target };
    if (hasSecret(url.href)) return { decision: 'deny', reason: '주소에 비밀정보 형식이 들어 있음 (유출 차단)', target };
    if (url.search.length > 300) return { decision: 'deny', reason: '주소 뒤에 붙은 데이터가 너무 김 (유출 의심)', target };
    const host = url.hostname.toLowerCase();
    // 대장 규칙 (after the fixed rules above): 금지 always wins; 승인 필요 asks even in open web mode; 허용 skips the ask.
    const rule = ruleFor(rules, { kind: 'site', target: host, project });
    if (rule?.action === 'deny') return { decision: 'deny', reason: `대장 규칙으로 금지된 사이트${rule.note ? ` (${rule.note})` : ''}`, target };
    if (rule?.action === 'allow') return { decision: 'allow', reason: '대장 규칙으로 허용된 사이트', target };
    if (rule?.action === 'ask') {
      if (granted(grants, { kind: 'web', target: host, project }, now)) return { decision: 'allow', reason: '대장 규칙 · 승인받은 사이트', target };
      return { decision: 'ask', reason: `대장 규칙 · 이 사이트는 승인 필요${rule.note ? ` (${rule.note})` : ''}`, target, ask: { kind: 'web', target: host } };
    }
    if (webMode === 'open' || granted(grants, { kind: 'web', target: host, project }, now)) return { decision: 'allow', reason: '공개 https 주소', target };
    return { decision: 'ask', reason: '처음 여는 사이트 · 대장 승인 필요', target, ask: { kind: 'web', target: host } };
  }
  if (tool === 'WebSearch') {
    const query = String(args.query ?? '');
    if (hasSecret(query)) return { decision: 'deny', reason: '검색어에 비밀정보 형식이 들어 있음 (유출 차단)', target: '[가림]' };
    if (query.length > 300) return { decision: 'deny', reason: '검색어가 너무 김 (유출 의심)', target: `${query.length}자` };
    return { decision: 'allow', reason: '웹 검색', target: query.slice(0, 80) };
  }
  // Reading and searching (Read, Glob, Grep): only inside the work folder, and never a .env file. A read inside the
  // folder passes without a log line (reads are many and change nothing); a blocked one is logged.
  if (READ_TOOLS.includes(tool)) {
    if (!workspace) return { decision: 'deny', reason: '작업 폴더를 알 수 없음', target: tool };
    const root = path.resolve(workspace);
    const where = String(args.file_path ?? args.path ?? '');
    const rel = path.relative(root, path.resolve(root, where || '.'));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { decision: 'deny', reason: '작업 폴더 밖은 읽거나 찾을 수 없음', target: path.basename(where) };
    // Glob's pattern and Grep's glob are file paths (Grep's own pattern is the text searched for).
    const filePattern = tool === 'Glob' ? args.pattern : tool === 'Grep' ? args.glob : null;
    if (typeof filePattern === 'string' && (path.isAbsolute(filePattern) || /^[a-zA-Z]:/.test(filePattern) || /(^|[\\/])\.\.([\\/]|$)/.test(filePattern))) {
      return { decision: 'deny', reason: '작업 폴더 밖을 가리키는 찾기 패턴', target: tool };
    }
    if (rel.split(/[\\/]/).some(part => /^\.env(\..+)?$/i.test(part) && !/\.example$/i.test(part))) return { decision: 'deny', reason: '비밀 파일(.env)은 읽지 않음', target: rel };
    return { decision: 'ignore', reason: '', target: '' };
  }
  if (WRITE_TOOLS.includes(tool)) {
    const file = String(args.file_path ?? args.notebook_path ?? '');
    if (!workspace) return { decision: 'deny', reason: '작업 폴더를 알 수 없음', target: path.basename(file) };
    const root = path.resolve(workspace);
    const full = path.resolve(root, file);
    const rel = path.relative(root, full);
    if (!file || rel.startsWith('..') || path.isAbsolute(rel)) return { decision: 'deny', reason: '작업 폴더 밖에 쓰려 함', target: path.basename(file) };
    const blocked = rel.split(/[\\/]/).find(part => FORBIDDEN_NAMES.test(part));
    if (blocked) return { decision: 'deny', reason: `설정·지시·비밀 파일은 만들 수 없음 (${blocked})`, target: rel };
    if (/^sources([\\/]|$)/.test(rel)) return { decision: 'deny', reason: '웹 원문 폴더(sources/)는 엔진만 씀', target: rel };
    if (/^\.hq-screens([\\/]|$)/.test(rel)) return { decision: 'deny', reason: '화면 캡처 폴더(.hq-screens/)는 엔진만 씀', target: rel };
    const content = [args.content, args.file_text, args.new_string, args.new_source, ...(Array.isArray(args.edits) ? args.edits.map(e => e?.new_string) : [])];
    if (content.some(hasSecret)) return { decision: 'deny', reason: '비밀정보 형식을 파일에 쓰려 함', target: rel };
    const relPath = rel.split(path.sep).join('/');
    // 병렬 작업: a lane writes only in its own folder; its parent never writes into an open lane's folder.
    if (lane && !relPath.startsWith(lane)) return { decision: 'deny', reason: `병렬 작업은 자기 폴더(${lane})에만 씀`, target: relPath };
    if ((laneDeny ?? []).some(p => relPath.startsWith(p))) return { decision: 'deny', reason: '진행 중인 병렬 작업의 폴더라 쓸 수 없음', target: relPath };
    const rule = ruleFor(rules, { kind: 'path', target: relPath, project });
    if (rule?.action === 'deny') return { decision: 'deny', reason: `대장 규칙으로 금지된 경로${rule.note ? ` (${rule.note})` : ''}`, target: relPath };
    if (rule?.action === 'ask' && !granted(grants, { kind: 'path', target: relPath, project }, now)) {
      return { decision: 'ask', reason: `대장 규칙 · 이 경로는 승인 필요${rule.note ? ` (${rule.note})` : ''}`, target: relPath, ask: { kind: 'path', target: relPath } };
    }
    return { decision: 'allow', reason: '작업 폴더 안 파일', target: rel };
  }
  if (tool.startsWith('mcp__')) {
    const rule = ruleFor(rules, { kind: 'connector', target: tool, project });
    if (rule?.action === 'deny') return { decision: 'deny', reason: `대장 규칙으로 금지된 연결 도구${rule.note ? ` (${rule.note})` : ''}`, target: tool };
    if (rule?.action === 'allow') return { decision: 'allow', reason: '대장 규칙으로 허용된 연결 도구', target: tool };
    if ((rule?.action === 'ask' || RISKY_CONNECTOR.test(tool)) && !granted(grants, { kind: 'connector', target: tool, project }, now)) {
      return { decision: 'ask', reason: '삭제·공유·게시·전송·결제 성격의 커넥터 동작 · 대장 승인 필요', target: tool, ask: { kind: 'connector', target: tool } };
    }
    return { decision: 'allow', reason: '연결된 도구', target: tool };
  }
  return { decision: 'ignore', reason: '', target: '' };
}

// The approval asks the Sentinel logged for one project since a moment (one round).
export function readAsks(file, { project, since }) {
  let lines = [];
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-5000); } catch { return []; }
  return lines.flatMap((l) => { try { const e = JSON.parse(l); return e.decision === 'ask' && e.project === project && e.at >= since && e.ask ? [{ ...e.ask, reason: e.reason, team: e.team, tool: e.tool, detail: e.target }] : []; } catch { return []; } });
}

export function logDecision(file, entry) {
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

// Claude Code hook settings that run the Sentinel before every tool call (exec form: no shell quoting).
export function sentinelSettings(script) {
  return { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: process.execPath, args: [script], timeout: 30 }] }] } };
}
