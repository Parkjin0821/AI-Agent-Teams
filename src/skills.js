import { createHash } from 'node:crypto';
import { TEAMS } from './teams.js';

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
export function skillChecks(body, license) {
  const doc = String(body ?? '');
  const licName = license?.content ? (LICENSES.find(([, re]) => re.test(license.content))?.[0] ?? '알 수 없음') : '없음';
  const tool = doc.match(NEEDS_TOOL);
  return { license: { name: licName, ok: PERMISSIVE.includes(licName) }, tool: { needed: !!tool, hint: tool ? tool[0] : '' },
    risks: RISKY.filter(([re]) => re.test(doc)).map(([, why]) => why), size: { ok: doc.length <= 12000 } };
}

// Instruction-only candidates. No checkout, package installation, scripts or credentials.
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
    const description = text(input.description, 500), body = text(input.body, 12000);
    const teams = input.teams;
    if (!Array.isArray(teams) || !teams.length || teams.some(t => !TEAMS[t])) throw new Error('invalid skill teams');
    const triggers = input.triggers;
    if (!Array.isArray(triggers) || !triggers.length || triggers.length > 10) throw new Error('skill triggers required');
    const normalized = triggers.map(t => text(t, 80).toLowerCase());
    const source = input.source || 'local';
    const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
    const id = hash(JSON.stringify({content,teams,normalized,source}));
    const prior = this.list().find(s => s.id === id);
    if (prior) return prior;
    const entry = {id,name,description,body,content,teams,triggers:normalized,source,status:'pending', reviews:{},
      checks: skillChecks(body, input.license), createdAt:new Date().toISOString()};
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
  activate(id, input) {
    const entry = this.list().find(s => s.id === id);
    if (!entry || input.confirm !== true || ['security','policy','compatibility'].some(k => entry.reviews[k]?.pass !== true)) throw new Error('skill review and approval required');
    const updated = {...entry,status:'active',approvedAt:new Date().toISOString()};
    this.store.setSetting('skill.entry.' + id, updated); return updated;
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
  select(team, task) {
    const query = String(task || '').toLowerCase();
    return this.list().filter(s => s.status === 'active' && s.teams.includes(team) && s.triggers.some(t => query.includes(t))).slice(0,2);
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
    if(result.type !== 'file' || result.encoding !== 'base64' || result.size > 12000) throw new Error('unsupported skill document');
    const body = Buffer.from(result.content,'base64').toString('utf8');
    return this.register({...input,body,source:`https://github.com/${input.repository}/blob/${input.commit}/${file}`});
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
      let targets=[];
      if(repo) targets=[repo];
      else {
        const query=/디자인|화면|레이아웃|테마|폰트/i.test(request)?'design':/개발|테스트|코드/i.test(request)?'coding':request.slice(0,120);
        const found=await this.discover({query});
        targets=found.candidates.slice(0,3).map(c=>({repository:c.repository}));
      }
      const items=[],notes=[];
      for(const target of targets) {
        if(items.length>=3)break;
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
              paths=(tree.tree||[]).filter(f=>f.type==='blob'&&/(^|\/)SKILL\.md$/.test(f.path)&&!/(^|\/)(node_modules|\.git)\//.test(f.path)).map(f=>f.path).slice(0,6);
            } catch { /* fall back to the root and the skills/ folder */ }
            if(!paths.length) {
              const root=await this.github('/repos/'+target.repository+'/contents?ref='+commit);
              if(root.some(f=>f.name==='SKILL.md'&&f.type==='file'))paths.push('SKILL.md');
              const directory=root.find(f=>f.name==='skills'&&f.type==='dir');
              if(directory){const children=await this.github('/repos/'+target.repository+'/contents/skills?ref='+commit);paths.push(...children.filter(f=>f.type==='dir').slice(0,6).map(f=>f.path+'/SKILL.md'));}
            }
          }
          if(!paths.length) notes.push(target.repository+' · SKILL.md가 없음 (스킬이 아니라 프로그램일 수 있음)');
          for(const path of paths.slice(0,6)) {
            if(items.length>=3)break;
            try {
              const doc=await this.github('/repos/'+target.repository+'/contents/'+path+'?ref='+commit);
              if(doc.type!=='file'||doc.encoding!=='base64'||doc.size>12000)continue;
              const body=Buffer.from(doc.content,'base64').toString('utf8');
              const name=body.match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1];
              if(!name)continue;
              const description=(body.match(/^description:\s*(.+)$/m)?.[1] || 'GitHub에서 가져온 스킬 · 용도 검토 필요').slice(0,500);
              const design=/design|theme|typograph|canvas|디자인/i.test(name+' '+description);
              const teams=design?['design']:['dev'];
              const source=`https://github.com/${target.repository}/blob/${commit}/${path}`;
              let license=null;
              for(const lp of [path.replace(/SKILL\.md$/,'LICENSE.txt'),'LICENSE','LICENSE.txt','LICENSE.md']){
                try{const l=await this.github('/repos/'+target.repository+'/contents/'+lp+'?ref='+commit);if(l.type==='file'&&l.encoding==='base64'&&l.size<20000){license={name:'원문 수집 · 판정 전',content:Buffer.from(l.content,'base64').toString('utf8'),source:`https://github.com/${target.repository}/blob/${commit}/${lp}`};break;}}catch{/* missing license is not approval */}
              }
              const entry=this.register({name,description,body,source,teams,triggers:[name,...(design?['디자인','화면']:['코드','개발'])]});
              // Preserve prior approval and evidence on duplicate intake.
              if(!entry.importedAt)this.store.setSetting('skill.entry.'+entry.id,{...entry,license,checks:skillChecks(body,license),
                intakeNote:'SKILL.md만 수집. 추가 자료·도구 의존성·라이선스 적합성·실제 동작 검토 전.',importedAt:new Date().toISOString()});
              items.push({id:entry.id,name:entry.name,status:entry.status});
            }catch{notes.push(path+' · 원문 수집 실패 또는 지원 형식 아님');}
          }
        }catch{notes.push(target.repository+' · 접근 실패 또는 지원 경로 없음');}
      }
      return {items,notes,empty:!items.length};
    }finally{this.busy=false;}
  }
}
