import { createHash } from 'node:crypto';
import { TEAMS } from './teams.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid skill text');
  return value.trim();
};
// Instruction-only candidates. No checkout, package installation, scripts or credentials.
export class SkillLibrary {
  constructor({ store, fetcher = fetch }) { this.store = store; this.fetcher = fetcher; }
  list() { return Object.entries(this.store.getSettings()).filter(([k]) => k.startsWith('skill.entry.')).map(([,v]) => v); }
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
    const entry = {id,name,description,body,content,teams,triggers:normalized,source,status:'pending', reviews:{},createdAt:new Date().toISOString()};
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
}
