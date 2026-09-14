import test from 'node:test';
import assert from 'node:assert/strict';
import {runSocialPostMonitor} from '../lib/social-post-monitor.mjs';
const source={id:'ajc',agent:'Average Joe Crypto',platform:'X',accountUrl:'https://x.com/AvrgJoeCrypto',status:'已启用',postMonitoring:true,postSyncMode:'verified',targets:[{platform:'discord',guildId:'g',channelId:'c'}]};
const old={platform:'X',ownerId:'avrgjoecrypto',id:'1',title:'Old',publishedAt:'2026-09-14T01:00:00Z',url:'https://x.com/AvrgJoeCrypto/status/1'};
const fresh=id=>({...old,id,title:'New '+id,publishedAt:'2026-09-14T02:01:00Z',url:'https://x.com/AvrgJoeCrypto/status/'+id});
function repo(){const data=new Map();return {getMeta:async k=>data.get(k)||null,setMeta:async(k,v)=>data.set(k,structuredClone(v)),listMetaByPrefix:async p=>[...data].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value})),compareAndSetMeta:async(k,e,v)=>{const c=data.get(k);if(e.absent?!!c:Object.entries(e).some(([f,x])=>c?.[f]!==x))return null;data.set(k,structuredClone(v));return v;},acquireMetaLease:async(k,v,n)=>{if(Date.parse(data.get(k)?.leaseUntil)>n.getTime())return null;data.set(k,v);return v;},releaseMetaLease:async(k,id)=>{if(data.get(k)?.leaseId===id)data.delete(k);}};}
function opts(repository,sent,extra={}){return {repository,loadSources:async()=>[source],fetchPosts:async()=>({posts:[old],ownerId:old.ownerId,strategy:'test'}),deliver:async e=>{sent.push(e);return {status:'success',messageId:'42'}},now:'2026-09-14T02:00:00Z',...extra};}
test('first activation does not backfill; all subsequent new IDs are delivered once despite edits and repeated checks',async()=>{
 const repository=repo(),sent=[];await runSocialPostMonitor(opts(repository,sent));assert.equal(sent.length,0);
 const later=opts(repository,sent,{now:'2026-09-14T02:05:00Z',fetchPosts:async()=>({ownerId:old.ownerId,posts:[fresh('3'),fresh('2'),old]})});await runSocialPostMonitor(later);await runSocialPostMonitor({...later,now:'2026-09-14T02:10:00Z',fetchPosts:async()=>({ownerId:old.ownerId,posts:[{...fresh('2'),title:'Edited'},fresh('3')]})});assert.equal(sent.length,2);
});
test('duplicate configurations and concurrent runs share per-post exact-target receipts',async()=>{
 const repository=repo(),sent=[];await runSocialPostMonitor(opts(repository,sent));
 const later=opts(repository,sent,{now:'2026-09-14T02:05:00Z',loadSources:async()=>[source,{...source,id:'alias'}],fetchPosts:async()=>({ownerId:old.ownerId,posts:[fresh('2')]})});await Promise.all([runSocialPostMonitor(later),runSocialPostMonitor(later)]);assert.equal(sent.length,1);
});
test('unknown send outcome is fenced without retry while another post can be delivered',async()=>{
 const repository=repo(),sent=[];await runSocialPostMonitor(opts(repository,sent));let calls=0;const later=opts(repository,sent,{now:'2026-09-14T02:05:00Z',fetchPosts:async()=>({ownerId:old.ownerId,posts:[fresh('2'),fresh('3')]}),deliver:async e=>{calls++;if(e.post.id==='2')throw new Error('timeout');return {status:'success',messageId:'42'}}});const r=await runSocialPostMonitor(later);assert.equal(r.status,'partial');await runSocialPostMonitor({...later,now:'2026-09-14T02:10:00Z'});assert.equal(calls,2);
});
test('paused, legacy, preview and source paused during lookup never send',async()=>{
 const repository=repo(),sent=[];await runSocialPostMonitor(opts(repository,sent,{dryRun:true}));assert.equal((await repository.listMetaByPrefix('social-post:')).length,0);
 await runSocialPostMonitor(opts(repository,sent,{loadSources:async()=>[{...source,status:'已暂停'},{...source,postSyncMode:undefined}]}));assert.equal(sent.length,0);
 await runSocialPostMonitor(opts(repository,sent));let reads=0;await runSocialPostMonitor(opts(repository,sent,{now:'2026-09-14T02:05:00Z',loadSources:async()=>[++reads===1?source:{...source,status:'已暂停'}],fetchPosts:async()=>({ownerId:old.ownerId,posts:[fresh('2')]})}));assert.equal(sent.length,0);
});
test('a newly added destination establishes its own baseline and cannot replay earlier posts',async()=>{
 const repository=repo(),sent=[];await runSocialPostMonitor(opts(repository,sent));
 await runSocialPostMonitor(opts(repository,sent,{now:'2026-09-14T02:05:00Z',loadSources:async()=>[{...source,targets:[...source.targets,{platform:'discord',guildId:'g',channelId:'new'}]}],fetchPosts:async()=>({ownerId:old.ownerId,posts:[fresh('2')]})}));assert.equal(sent.length,1);assert.equal(sent[0].target.channelId,'c');
});
