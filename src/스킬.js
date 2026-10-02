import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEAMS } from './팀.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid skill text');
  return value.trim();
};

// "owner/repo", "gh repo clone owner/repo", "git clone https://github.com/owner/repo.git", "github.com/owner/repo/…" → a GitHub target.
// Anything else is a search phrase (null).
export function parseRepoRequest(request) {
  let r = String(request ?? '').trim().replace(/^(?:gh\s+repo\s+clone|git\s+clone)\s+/i, '').replace(/\.git$/i, '');
  if (/^github\.com\//i.test(r)) r = 'https://' + r;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) return { repository: r };
  if (!r.startsWith('https://')) return null;
  const url = new URL(r);
  if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('public GitHub link required');
  const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
  if (parts.length < 2 || !parts.slice(0, 2).every(p => /^[A-Za-z0-9_.-]+$/.test(p))) throw new Error('invalid GitHub repository');
  if (parts.length > 2 && !(['blob', 'tree'].includes(parts[2]) && /^[A-Za-z0-9_.-]+$/.test(parts[3] || ''))) throw new Error('unsupported GitHub link');
  return { repository: parts.slice(0, 2).join('/'), ref: parts[3], path: parts.slice(4).join('/') };
}

// Engine checks (no model call) shown next to 대장's reviews. They inform the reviews; they never approve anything.
const LICENSES = [['MIT', /\bMIT License\b|Permission is hereby granted, free of charge/i], ['Apache-2.0', /Apache License,?\s+Version 2\.0/i],
  ['BSD', /Redistribution and use in source and binary forms/i], ['ISC', /\bISC License\b/i],
  ['GPL', /GNU (?:AFFERO |LESSER )?GENERAL PUBLIC LICENSE/i], ['CC', /Creative Commons/i]];
const PERMISSIVE = ['MIT', 'Apache-2.0', 'BSD', 'ISC'];
const NEEDS_TOOL = /\b(?:npx|npm\s+(?:i|install)|pnpm\s+add|yarn\s+add|pip3?\s+install|uvx|docker\s+run|brew\s+install|mcp[_ -]?server|mcpServers|claude\s+mcp\s+add)\b/i;
const RISKY = [[/(?:curl|wget)[^\n]*\|\s*(?:ba)?sh/i, '내려받은 스크립트를 바로 실행하라는 지시'], [/rm\s+-rf|Remove-Item[^\n]*-Recurse/i, '파일을 지우는 명령'],
  [/ignore (?:all |any )?(?:previous|prior|above) instructions|system prompt|이전 지시를 무시/i, '다른 지시를 무시하라는 문구'],
  [/(?:api[_ -]?key|access[_ -]?token|password|비밀번호|토큰)\S*\s*(?:입력|붙여|paste|enter|provide)/i, '키·토큰·비밀번호를 요구'],
  [/--dangerously|bypassPermissions|--no-verify/i, '안전장치를 끄는 옵션']];
// The longest skill document accepted. 12,000 characters until 2026-10-01; open-slide's slide-authoring reference is
// 24.7 KB, so 32,000; design-taste-frontend (MIT) is 44.6 KB, so 50,000 (2026-10-01). A selected skill is only added to
// the steps whose task matches its triggers.
export const SKILL_MAX = 50000;
export function skillChecks(body, license) {
  const doc = String(body ?? '');
  const licName = license?.content ? (LICENSES.find(([, re]) => re.test(license.content))?.[0] ?? '알 수 없음') : '없음';
  const tool = doc.match(NEEDS_TOOL);
  return { license: { name: licName, ok: PERMISSIVE.includes(licName) }, tool: { needed: !!tool, hint: tool ? tool[0] : '' },
    risks: RISKY.filter(([re]) => re.test(doc)).map(([, why]) => why), size: { ok: doc.length <= SKILL_MAX } };
}

// AGENT HQ's own skills live in docs/skills/ in this repo. A skill registered as source 'agent-hq' whose text is exactly
// one of those files is our own writing, so it needs no outside license (seen 2026-10-01: our own design skill showed
// license "없음" and never reached the inbox). A skill that only claims to be ours is refused.
const OWN_DIR = new URL('../docs/skills/', import.meta.url);
const sameText = (a, b) => String(a).replace(/\r\n/g, '\n').trim() === String(b).replace(/\r\n/g, '\n').trim();
export function ownSkillFile(body, { dir = OWN_DIR } = {}) {
  const root = typeof dir === 'string' ? dir : fileURLToPath(dir);
  let files = [];
  try { files = readdirSync(root).filter(f => f.endsWith('.md')); } catch { return null; }
  return files.find(f => { try { return sameText(readFileSync(path.join(root, f), 'utf8'), body); } catch { return false; } }) ?? null;
}

// A skill whose document needs a separate program (npx, MCP …) is a tool, not an instruction: it is kept as a
// "도구 연결 후보" and can never be turned on as a skill (the program must be installed and connected as an engine tool).
export const kindOf = entry => (entry?.checks?.tool?.needed ? 'tool' : 'instruction');
// Candidates 대장 can approve in one step from the inbox: instruction-only, allowed license, no risky wording.
export const quickApprovable = entry => kindOf(entry) === 'instruction' && entry?.checks?.license?.ok === true && !(entry?.checks?.risks?.length);
export const DEFAULT_TRUSTED = ['anthropics/skills'];
// Search words per requested topic, matched against SKILL.md paths in trusted repositories.
const TOPIC_WORDS = { design: ['design', 'frontend', 'canvas', 'theme', 'brand', 'art'], coding: ['code', 'develop', 'builder', 'webapp', 'mcp'],
  testing: ['test'], accessibility: ['accessib', 'a11y'], documentation: ['doc', 'pdf', 'pptx', 'xlsx', 'writ'] };
const APPLIED_NOTICE = 3; // the first uses of a newly enabled skill are shown on the run
const MATCH_STOP_WORDS = new Set(['프로젝트', '작업', '수정', '생성', '구현', '추가', '확인', '기능', 'create', 'make', 'with', 'from', 'using', 'project']);
const MATCH_EQUIVALENTS = { ui:['화면','인터페이스'], ux:['사용성','사용자경험'], frontend:['프론트엔드','웹화면'],
  프론트엔드:['frontend','화면'], 테스트:['testing','test'], 문서:['documentation','document'] };
const matchTerms = value => [...new Set(String(value || '').toLowerCase().match(/[가-힣]{2,}|[a-z0-9]{3,}|\bui\b|\bux\b/g) || [])]
  .filter(term => !MATCH_STOP_WORDS.has(term));
function matchScore(skill, query) {
  const text = String(query || '').toLowerCase();
  if (!text.trim()) return 0;
  const triggers = skill.triggers || [];
  const exact = triggers.filter(trigger => trigger && text.includes(trigger.toLowerCase()));
  if (exact.length) return 100 + Math.max(...exact.map(trigger => trigger.length));
  const name = skill.name.toLowerCase().replaceAll('-', ' ');
  if (text.includes(name)) return 90;
  const description = String(skill.description || '').toLowerCase();
  const terms = matchTerms(text).filter(term => [term,...(MATCH_EQUIVALENTS[term] || [])]
    .some(candidate => name.includes(candidate) || description.includes(candidate)));
  return terms.length ? 10 + terms.length : 0;
}

// Instruction-only candidates. No checkout, package installation, scripts or credentials.
// Approved skills a team always gets, whatever the task text says (each still needs 대장's approval to be active).
const BASELINE_SKILLS = Object.freeze({ design: ['frontend-design', 'agent-hq-screen-design'] });
// Slide and document work have their own baselines (checked in this order; "문서" alone is too common, since every
// screen task mentions its 화면설계 document).
const TASK_BASELINES = Object.freeze([
  { test: /슬라이드|발표|slides?\b|deck|ppt|프레젠테이션/i, teams: ['design', 'dev'], skills: ['agent-hq-slides', 'slide-authoring'] },
  { test: /회의록|보고서|계획서|기안문|업무보고|신청서|양식|hwpx?|한글 문서/i, teams: ['dev', 'design'], skills: ['agent-hq-documents', 'document-typography-design'] },
]);

export class SkillLibrary {
  constructor({ store, fetcher = fetch }) { this.store = store; this.fetcher = fetcher; }
  list() { return Object.entries(this.store.getSettings()).filter(([k, v]) => k.startsWith('skill.entry.') && v).map(([,v]) => v); }
  needs() { return Object.entries(this.store.getSettings()).filter(([k, v]) => k.startsWith('skill.need.') && v).map(([,v]) => v); }
  requestNeeds(items, { team, project }) {
    if (!TEAMS[team] || !Array.isArray(items)) return;
    // Only engine-owned generic terms may leave the machine, never model-supplied queries.
    for (const item of items.slice(0, 2)) {
      if (!['design', 'coding', 'testing', 'accessibility', 'documentation'].includes(item?.topic)) continue;
      if (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 500) continue;
      const id = hash(JSON.stringify([project, team, item.topic]));
      if (this.needs().some(n => n.id === id)) continue;
      if (this.needs().length >= 100) break;
      this.store.setSetting('skill.need.' + id, { id, team, project, topic: item.topic,
        reason: item.reason.trim(), status: 'queued', createdAt: new Date().toISOString() });
    }
  }
  async processNeed() {
    if (this.processing || this.busy) return;
    const need = this.needs().find(n => n.status === 'queued');
    if (!need) return;
    this.processing = true;
    const save = value => this.store.setSetting('skill.need.' + need.id, { ...need, ...value });
    // Persist before network so a crash cannot create an endless automatic retry loop.
    save({ status: 'searching' });
    try {
      const result = await this.intake({ request: need.topic });
      save({ status: result.items.length ? 'review_pending' : result.notes?.length ? 'search_incomplete' : 'creation_pending',
        candidates: result.items.map(s => s.id), notes: result.notes,
        completedAt: new Date().toISOString() });
    } catch (error) {
      save({ status: 'search_failed', error: String(error.message).slice(0, 300) });
    } finally { this.processing = false; }
  }
  register(input) {
    const name = text(input.name, 63);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('invalid skill name');
    const description = text(input.description, 500), body = text(input.body, SKILL_MAX);
    const teams = input.teams;
    if (!Array.isArray(teams) || !teams.length || teams.some(t => !TEAMS[t])) throw new Error('invalid skill teams');
    const triggers = input.triggers;
    if (!Array.isArray(triggers) || !triggers.length || triggers.length > 10) throw new Error('skill triggers required');
    const normalized = triggers.map(t => text(t, 80).toLowerCase());
    const source = input.source || 'local';
    const own = source === 'agent-hq' ? ownSkillFile(body) : null;
    if (source === 'agent-hq' && !own) throw new Error('an AGENT HQ skill must match a file in docs/skills');
    const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
    const id = hash(JSON.stringify({content,teams,normalized,source}));
    const prior = this.list().find(s => s.id === id);
    if (prior) return prior;
    const entry = {id,name,description,body,content,teams,triggers:normalized,source,status:'pending', reviews:{},
      checks: own ? { ...skillChecks(body, null), license: { name: 'AGENT HQ 자체 작성', ok: true, file: 'docs/skills/' + own } } : skillChecks(body, input.license),
      createdAt:new Date().toISOString()};
    this.store.setSetting('skill.entry.' + id, entry); return entry;
  }
  draft(input) {
    const purpose = text(input.purpose, 2000);
    return this.register({...input, description:input.description || purpose.slice(0,500),
      body:`적용 목적: ${purpose}\n\n필요한 입력을 확인하고 부족한 정보는 질문한다.\n현재 작업 범위에서 결과물을 만들고 실제 확인과 미확인 사항을 나눠 보고한다.\n기존 권한·안전 경계·출력 JSON 계약을 변경하지 않는다.\n이 초안은 목적 기반 템플릿이며 전문 절차와 검증 사례를 작성한 뒤 승인한다.`});
  }
  review(id, input) {
    const entry = this.list().find(s => s.id === id);
    if (!entry || !['security','policy','compatibility'].includes(input.kind) || typeof input.pass !== 'boolean') throw new Error('invalid skill review');
    const note = text(input.note, 1500);
    const reviews = {...entry.reviews,[input.kind]:{pass:input.pass,note,by:'대장',at:new Date().toISOString()}};
    const updated = {...entry,reviews,status:'pending'}; // every new review revokes activation
    this.store.setSetting('skill.entry.' + id, updated); return updated;
  }
  setTeams(id, teams) {
    const entry = this.list().find(s => s.id === id);
    if (!entry || !Array.isArray(teams) || !teams.length || teams.some(team => !TEAMS[team])) throw new Error('invalid skill teams');
    const clean = [...new Set(teams)];
    if (clean.length === entry.teams.length && clean.every(team => entry.teams.includes(team))) return entry;
    const reviews = {...entry.reviews};
    delete reviews.compatibility;
    const updated = {...entry, teams:clean, reviews, status:'pending', routingUpdatedAt:new Date().toISOString()};
    this.store.setSetting('skill.entry.' + id, updated);
    return updated;
  }
  activate(id, input) {
    const entry = this.list().find(s => s.id === id);
    if (entry && kindOf(entry) === 'tool') throw new Error('this skill needs a separate program; connect it as an engine tool instead');
    if (!entry || input.confirm !== true || ['security','policy','compatibility'].some(k => entry.reviews[k]?.pass !== true)) throw new Error('skill review and approval required');
    const updated = {...entry,status:'active',approvedAt:new Date().toISOString()};
    this.store.setSetting('skill.entry.' + id, updated); return updated;
  }
  // One-step approval from the inbox: only for candidates whose engine checks are all clean. 대장's decision is
  // recorded as the three reviews (with the engine findings as notes), then the skill is turned on.
  approveFromInbox(id, input) {
    const entry = this.list().find(s => s.id === id);
    if (!entry || input.confirm !== true) throw new Error('skill review and approval required');
    if (!quickApprovable(entry)) throw new Error('this candidate needs a detailed review on the skills page');
    const at = new Date().toISOString(), c = entry.checks;
    const reviews = { security: { pass: true, note: '승인함에서 승인 · 엔진 검사: 위험 문구 없음', by: '대장', at },
      policy: { pass: true, note: `승인함에서 승인 · 라이선스 ${c.license.name}`, by: '대장', at },
      compatibility: { pass: true, note: '승인함에서 승인 · 글로 된 지침형', by: '대장', at } };
    const updated = { ...entry, reviews, status: 'active', approvedAt: at, approvedVia: 'inbox' };
    this.store.setSetting('skill.entry.' + id, updated); return updated;
  }
  // Counts uses of enabled skills; the first APPLIED_NOTICE uses are flagged so 대장 sees the skill at work.
  markApplied(skills) {
    return skills.map(s => {
      const entry = this.list().find(x => x.id === s.id);
      if (!entry) return { id: s.id, name: s.name, n: 0, notice: false };
      const n = (entry.applied ?? 0) + 1;
      this.store.setSetting('skill.entry.' + s.id, { ...entry, applied: n, lastAppliedAt: new Date().toISOString() });
      return { id: s.id, name: s.name, n, notice: n <= APPLIED_NOTICE };
    });
  }
  trustedSources() { return this.store.getSettings()['skills.trustedSources'] ?? DEFAULT_TRUSTED; }
  setTrustedSources(list) {
    if (!Array.isArray(list) || list.length > 20) throw new Error('trusted sources must be a list of at most 20 repositories');
    const clean = [...new Set(list.map(r => String(r ?? '').trim()))].filter(Boolean);
    if (clean.some(r => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r))) throw new Error('trusted sources must look like owner/repo');
    this.store.setSetting('skills.trustedSources', clean); return clean;
  }
  disable(id) {
    const entry = this.list().find(s => s.id === id);
    if (!entry) throw new Error('unknown skill');
    this.store.setSetting('skill.entry.' + id,{...entry,status:'disabled'}); return {disabled:true};
  }
  // 대장 deletes a candidate or a skill; the entry is gone (a later import makes a new pending entry).
  remove(id) {
    const entry = this.list().find(s => s.id === id);
    if (!entry) throw new Error('unknown skill');
    if (this.store.deleteSetting) this.store.deleteSetting('skill.entry.' + id); else this.store.setSetting('skill.entry.' + id, null);
    return { removed: id, name: entry.name };
  }
  select(team, task, objective = '') {
    const eligible = this.list().filter(s => s.status === 'active' && kindOf(s) === 'instruction' && s.teams.includes(team));
    const ranked = query => eligible.map(skill => ({skill, score: matchScore(skill, query)}))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, 2).map(item => item.skill);
    const selected = ranked(task).length ? ranked(task) : ranked(objective);
    // A vague design handoff must not silently omit the approved baselines: the general frontend guidance and AGENT HQ's
    // own screen principles (learned from a four-way design comparison, 2026-10-01). Only active (approved) ones count.
    // A slide or document task takes that kind's skills as its baseline instead of the screen ones (seen 2026-10-01: the
    // two web-design baselines took the design team's places on a slide task and only one slide skill got in).
    const kind = TASK_BASELINES.find(b => b.teams.includes(team) && b.test.test(`${task ?? ''} ${objective ?? ''}`));
    const baseline = (kind ? kind.skills : BASELINE_SKILLS[team] ?? []).map(n => eligible.find(s => s.name === n)).filter(Boolean);
    return [...baseline, ...selected.filter(s => !baseline.some(b => b.id === s.id))].slice(0, Math.max(2, baseline.length + 1));
  }
  async github(endpoint) {
    const response = await this.fetcher('https://api.github.com' + endpoint,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'}});
    if (!response.ok) throw new Error('GitHub request failed: ' + response.status);
    let size = 0; const chunks=[];
    for await (const chunk of response.body) { size+=chunk.length; if(size>500000) throw new Error('GitHub response too large'); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async discover(input) {
    const query = text(input.query,120);
    // Only explicit search terms leave the machine; never the project conversation.
    const result = await this.github('/search/repositories?q=' + encodeURIComponent(query + ' skill in:name,description') + '&per_page=5');
    const candidates = (result.items || []).map(r=>({repository:r.full_name,url:r.html_url,description:r.description,license:r.license?.spdx_id || 'unknown',status:'discovered'}));
    this.store.setSetting('skill.discovery',{query,candidates,at:new Date().toISOString()});
    return {candidates};
  }
  async importGitHub(input) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository || '') || !/^[a-f0-9]{40}$/.test(input.commit || '')) throw new Error('repository and pinned commit required');
    const file = input.path || 'SKILL.md';
    if (!file.endsWith('SKILL.md') || file.length>200 || !file.split('/').every(p=>/^[A-Za-z0-9_-]+(?:\.md)?$/.test(p))) throw new Error('invalid skill path');
    const result = await this.github('/repos/' + input.repository + '/contents/' + file.split('/').map(encodeURIComponent).join('/') + '?ref=' + input.commit);
    if(result.type !== 'file' || result.encoding !== 'base64' || result.size > SKILL_MAX) throw new Error('unsupported skill document');
    const body = Buffer.from(result.content,'base64').toString('utf8');
    return this.register({...input,body,source:`https://github.com/${input.repository}/blob/${input.commit}/${file}`});
  }
  // Reads SKILL.md candidates from one repository (pinned to a commit) and registers them as pending.
  async collect(target,items,notes){
    try {
      const repoInfo=await this.github('/repos/'+target.repository);
      const ref=target.ref || repoInfo.default_branch;
      const commit=/^[a-f0-9]{40}$/.test(ref)?ref:(await this.github('/repos/'+target.repository+'/git/ref/heads/'+encodeURIComponent(ref))).object.sha;
      let paths=[];
      if(target.path)paths=[target.path.endsWith('SKILL.md')?target.path:target.path+'/SKILL.md'];
      else {
        // Every SKILL.md in the repository (root, skills/, plugins/*/skills/, .claude/skills/ …) from one tree listing.
        try {
          const tree=await this.github('/repos/'+target.repository+'/git/trees/'+commit+'?recursive=1');
          paths=(tree.tree||[]).filter(f=>f.type==='blob'&&/(^|\/)SKILL\.md$/.test(f.path)&&!/(^|\/)(node_modules|\.git)\//.test(f.path)).map(f=>f.path);
        } catch { /* fall back to the root and the skills/ folder */ }
        if(!paths.length && !target.match) {
          const root=await this.github('/repos/'+target.repository+'/contents?ref='+commit);
          if(root.some(f=>f.name==='SKILL.md'&&f.type==='file'))paths.push('SKILL.md');
          const directory=root.find(f=>f.name==='skills'&&f.type==='dir');
          if(directory){const children=await this.github('/repos/'+target.repository+'/contents/skills?ref='+commit);paths.push(...children.filter(f=>f.type==='dir').slice(0,6).map(f=>f.path+'/SKILL.md'));}
        }
        if(target.match) paths=paths.filter(p=>target.match.some(w=>p.toLowerCase().includes(w)));
        paths=paths.slice(0,6);
      }
      if(!paths.length) { if(!target.match) notes.push(target.repository+' · SKILL.md가 없음 (스킬이 아니라 프로그램일 수 있음)'); return; }
      for(const path of paths) {
        if(items.length>=3)break;
        try {
          const doc=await this.github('/repos/'+target.repository+'/contents/'+path+'?ref='+commit);
          if(doc.type!=='file'||doc.encoding!=='base64'||doc.size>SKILL_MAX)continue;
          const body=Buffer.from(doc.content,'base64').toString('utf8');
          const name=body.match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1];
          if(!name)continue;
          const description=(body.match(/^description:\s*(.+)$/m)?.[1] || 'GitHub에서 가져온 스킬 · 용도 검토 필요').slice(0,500);
          const design=/design|theme|typograph|canvas|디자인/i.test(name+' '+description);
          const teams=design?['design']:['dev'];
          const source='https://github.com/'+target.repository+'/blob/'+commit+'/'+path;
          let license=null;
          for(const lp of [path.replace(/SKILL\.md$/,'LICENSE.txt'),'LICENSE','LICENSE.txt','LICENSE.md']){
            try{const l=await this.github('/repos/'+target.repository+'/contents/'+lp+'?ref='+commit);if(l.type==='file'&&l.encoding==='base64'&&l.size<20000){license={name:'원문 수집 · 판정 전',content:Buffer.from(l.content,'base64').toString('utf8'),source:'https://github.com/'+target.repository+'/blob/'+commit+'/'+lp};break;}}catch{/* missing license is not approval */}
          }
          const entry=this.register({name,description,body,source,teams,triggers:[name,...(design?['디자인','화면']:['코드','개발'])]});
          // Preserve prior approval and evidence on duplicate intake.
          if(!entry.importedAt)this.store.setSetting('skill.entry.'+entry.id,{...entry,license,checks:skillChecks(body,license),trusted:!!target.trusted,
            intakeNote:'SKILL.md만 수집. 추가 자료·도구 의존성·라이선스 적합성·실제 동작 검토 전.',importedAt:new Date().toISOString()});
          items.push({id:entry.id,name:entry.name,status:entry.status});
        }catch{notes.push(path+' · 원문 수집 실패 또는 지원 형식 아님');}
      }
    }catch{notes.push(target.repository+' · 접근 실패 또는 지원 경로 없음');}
  }
  async intake(input) {
    if(this.busy) throw new Error('skill intake already running');
    const request=text(input.request,500);
    const repo=parseRepoRequest(request);
    if(input.mode==='draft' && repo) throw new Error('this is a GitHub repository; import it instead of making a draft');
    this.busy=true;
    try {
      if(input.mode==='draft') {
        const name='custom-'+hash(request).slice(0,12);
        return {items:[this.draft({name,purpose:request,teams:['design','dev'],triggers:[request.slice(0,80)]})],notes:['목적 기반 템플릿 초안입니다. 전문 절차·실제 검증은 아직 없습니다.']};
      }
      const items=[],notes=[];
      if(repo) await this.collect(repo,items,notes);
      else {
        const topic=TOPIC_WORDS[request]?request:/디자인|화면|레이아웃|테마|폰트/i.test(request)?'design':/개발|코드/i.test(request)?'coding':/테스트/i.test(request)?'testing':null;
        const words=topic?TOPIC_WORDS[topic]:request.toLowerCase().split(/\s+/).filter(w=>w.length>1).slice(0,5);
        // Trusted sources first (대장's list, default anthropics/skills): only SKILL.md paths that match the topic.
        for(const trusted of this.trustedSources()){ if(items.length>=3)break; await this.collect({repository:trusted,match:words,trusted:true},items,notes); }
        if(!items.length){
          const found=await this.discover({query:topic||request.slice(0,120)});
          for(const c of found.candidates.slice(0,3)){ if(items.length>=3)break; await this.collect({repository:c.repository},items,notes); }
        }
      }
      return {items,notes,empty:!items.length};
    }finally{this.busy=false;}
  }
}
