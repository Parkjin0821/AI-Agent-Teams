import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillLibrary } from '../src/skills.js';
const setup = () => { const values={}; return new SkillLibrary({store:{getSettings:()=>structuredClone(values),setSetting:(k,v)=>{values[k]=structuredClone(v);}}}); };
const input = {name:'ui-layout',description:'화면 레이아웃 검토',body:'화면 정보 위계를 검토한다.',teams:['design'],triggers:['화면']};
test('pending skills never apply; three documented reviews and approval are required',()=>{
 const lib=setup(), skill=lib.register(input);
 assert.equal(lib.select('design','화면 제작').length,0);
 assert.throws(()=>lib.activate(skill.id,{confirm:true}));
 for(const kind of ['security','policy','compatibility'])lib.review(skill.id,{kind,pass:true,note:'원문과 적용 범위를 수동 검토함'});
 assert.throws(()=>lib.activate(skill.id,{confirm:false}));
 lib.activate(skill.id,{confirm:true});
 assert.equal(lib.select('design','화면 제작')[0].id,skill.id);
 assert.equal(lib.select('dev','화면 제작').length,0);
 assert.equal(lib.select('design','문서 제작').length,0);
 lib.review(skill.id,{kind:'security',pass:false,note:'재검토 필요'});
 assert.equal(lib.select('design','화면 제작').length,0);
});
test('new content is a separate pending version; disabling prevents selection',()=>{
 const lib=setup(), a=lib.register(input), b=lib.register({...input,body:'다른 절차'});
 assert.notEqual(a.id,b.id);assert.equal(lib.register(input).id,a.id);
 lib.disable(a.id);assert.equal(lib.list().find(s=>s.id===a.id).status,'disabled');
 assert.throws(()=>lib.register({...input,name:'../../unsafe'}));
 assert.throws(()=>lib.register({...input,teams:['unknown']}));
});
test('GitHub import rejects moving refs and unsafe paths before network',async()=>{
 const lib=setup();lib.fetcher=()=>{throw new Error('must not fetch');};
 await assert.rejects(lib.importGitHub({...input,repository:'owner/repo',commit:'main'}),/pinned/);
 await assert.rejects(lib.importGitHub({...input,repository:'owner/repo',commit:'a'.repeat(40),path:'../SKILL.md'}),/path/);
});
