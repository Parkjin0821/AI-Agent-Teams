import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { granted } from './승인.js';
import { ruleFor } from './규칙.js';

// 감시 에이전트 (Sentinel): a separate program Claude Code calls before every tool use (official
// PreToolUse hook). It decides from fixed rules, not from a model, so text on a web page or in a file
// cannot talk it out of a decision. Allowed web reads get an explicit "allow" answer (see hookOutput); other
// allowed calls get no answer (Claude Code's own permission rules still apply); blocked calls end with exit
// code 2, which Claude Code always honours.
// Every decision on an outward or file-changing action is logged without secret values.

const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}/, /\bsk-ant-[A-Za-z0-9_-]{20,}/, /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];
// The fingerprint of a text with whitespace runs collapsed (a relayed copy may differ in line breaks only).
export const textSha = text => createHash('sha256').update(String(text ?? '').replace(/\s+/g, ' ').trim()).digest('hex');
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
// mcpAllow { prefixes, tools }: the connector tools this step was given (실행어댑터.js); any other MCP tool is denied.
export function decide(input, { workspace, grants = [], project = null, webMode = 'open', now = Date.now(), rules = [], lane = null, laneDeny = [], mcpAllow = null, notionWrite = null } = {}) {
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
    // 외부 저장 (9차 2번): a Notion page is created only by the engine's approved report upload, and only with exactly the
    // approved parent, title and text (whitespace aside), once per upload (외부저장.js).
    if (/__notion-create-pages$/.test(tool)) {
      if (!notionWrite) return { decision: 'deny', reason: 'Notion 페이지 만들기는 대장이 승인한 보고서 올리기에서만', target: tool };
      if (notionWrite.payload && notionWrite.parent) return enginePayload(tool, args, notionWrite, 'create');
      const pages = Array.isArray(args.pages) ? args.pages : [];
      const page = pages[0] ?? {};
      const ok = Object.keys(args).every(k => ['parent', 'pages', 'allow_async'].includes(k))
        && String(args.parent?.page_id ?? '').replace(/-/g, '').toLowerCase() === notionWrite.parent
        && pages.length === 1 && Object.keys(page).every(k => ['properties', 'content'].includes(k))
        && Object.keys(page.properties ?? {}).join(',') === 'title' && page.properties.title === notionWrite.title
        && textSha(page.content) === notionWrite.contentSha;
      if (!ok) return { decision: 'deny', reason: 'Notion 쓰기 인수가 대장이 승인한 내용과 다름 (부모 페이지·제목·본문)', target: tool };
      if (notionWrite.once) {
        try { writeFileSync(notionWrite.once, new Date().toISOString(), { flag: 'wx' }); }
        catch { return { decision: 'deny', reason: '이 보고서는 이미 한 번 올림 (중복 방지)', target: tool }; }
      }
      return { decision: 'allow', reason: '대장이 승인한 보고서 올리기', target: tool };
    }
    // Notion 자동 기록 (10차): the project's own record page, made earlier by the engine, gets its content replaced with the
    // engine's newest record — that page only, the whole text exactly as the engine wrote it, once per update, and never
    // the option that deletes child pages. No other page can be changed.
    if (/__notion-update-page$/.test(tool)) {
      if (!notionWrite?.pageId) return { decision: 'deny', reason: 'Notion 페이지 고치기는 엔진의 자동 기록에서 그 프로젝트 기록 페이지만', target: tool };
      if (notionWrite.payload) return enginePayload(tool, args, notionWrite, 'update');
      const ok = Object.keys(args).every(k => ['page_id', 'command', 'new_str', 'allow_async'].includes(k))
        && String(args.page_id ?? '').replace(/-/g, '').toLowerCase() === notionWrite.pageId
        && args.command === 'replace_content' && typeof args.new_str === 'string' && textSha(args.new_str) === notionWrite.contentSha;
      if (!ok) return { decision: 'deny', reason: 'Notion 고치기 인수가 엔진 기록과 다름 (페이지·명령·본문)', target: tool };
      if (notionWrite.once) {
        try { writeFileSync(notionWrite.once, new Date().toISOString(), { flag: 'wx' }); }
        catch { return { decision: 'deny', reason: '이 기록은 이미 한 번 고침 (중복 방지)', target: tool }; }
      }
      return { decision: 'allow', reason: '프로젝트 기록 페이지 자동 갱신', target: tool };
    }
    // Read-only connectors (Notion) open single tools; everything else under them — create, update, comment — is denied.
    if (mcpAllow && !(mcpAllow.tools ?? []).includes(tool) && !(mcpAllow.prefixes ?? []).some(p => tool.startsWith(`${p}__`))) {
      return { decision: 'deny', reason: '이 단계에 열리지 않은 연결 도구 (읽기 전용 커넥터는 검색·읽기 도구만)', target: tool };
    }
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

// What the hook prints on stdout for a passed call. A web read the Sentinel allowed is answered with an explicit
// PreToolUse "allow": in a run without a screen (-p) Claude Code would otherwise refuse a site that is not in its
// own permission list, even though the Sentinel already checked it. Every other passed call gets no answer, so
// Claude Code's own permission rules still apply to files and connectors.
// 엔진 본문 끼워 넣기 (2026-10-18): a relay model copying 12,000 characters changed some of them, and the Sentinel rightly
// refused the write. With a payload file, the model only names the page (parent for a new page, the page for an
// update); the Sentinel checks that, checks the engine's payload against the approved parent/title/page and text
// fingerprint, and hands Notion exactly that payload (updatedInput). Once per upload, as before.
function enginePayload(tool, args, nw, mode) {
  let payload;
  try { payload = JSON.parse(readFileSync(nw.payload, 'utf8')); } catch { return { decision: 'deny', reason: '엔진 본문 파일을 읽을 수 없음', target: tool }; }
  const id = v => String(v ?? '').replace(/-/g, '').toLowerCase();
  const ok = mode === 'create'
    ? id(args.parent?.page_id) === nw.parent && id(payload.parent?.page_id) === nw.parent && Array.isArray(payload.pages) && payload.pages.length === 1
      && payload.pages[0].properties?.title === nw.title && textSha(payload.pages[0].content) === nw.contentSha && Object.keys(payload).every(k => ['parent', 'pages'].includes(k))
    : id(args.page_id) === nw.pageId && id(payload.page_id) === nw.pageId && payload.command === 'replace_content' && textSha(payload.new_str) === nw.contentSha
      && Object.keys(payload).every(k => ['page_id', 'command', 'new_str'].includes(k));
  if (!ok) return { decision: 'deny', reason: mode === 'create' ? 'Notion 만들기 대상이 승인한 부모 페이지와 다름' : 'Notion 고치기 대상이 기록 페이지와 다름', target: tool };
  if (nw.once) {
    try { writeFileSync(nw.once, new Date().toISOString(), { flag: 'wx' }); }
    catch { return { decision: 'deny', reason: '이 기록은 이미 한 번 보냄 (중복 방지)', target: tool }; }
  }
  return { decision: 'allow', reason: mode === 'create' ? '승인된 기록 페이지 만들기 (엔진 본문)' : '프로젝트 기록 페이지 자동 갱신 (엔진 본문)', target: tool, updatedInput: payload };
}

export function hookOutput(call, verdict) {
  if (verdict?.decision === 'allow' && verdict.updatedInput) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `AGENT HQ 감시 에이전트: ${verdict.reason}`, updatedInput: verdict.updatedInput } };
  }
  if (verdict?.decision !== 'allow' || !['WebFetch', 'WebSearch'].includes(call?.tool_name)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `AGENT HQ 감시 에이전트: ${verdict.reason}` } };
}

// Claude Code hook settings that run the Sentinel before every tool call (exec form: no shell quoting).
export function sentinelSettings(script) {
  return { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: process.execPath, args: [script], timeout: 30 }] }] } };
}
