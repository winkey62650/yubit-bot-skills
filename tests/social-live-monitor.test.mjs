import assert from 'node:assert/strict';
import test from 'node:test';
import { runSocialLiveMonitor, liveDeliveryKey, getSocialLiveStatus } from '../lib/social-live-monitor.mjs';
const source={id:'s1',name:'Academy YouTube',agent:'Academy',platform:'YouTube',accountUrl:'https://youtube.com/@academy',status:'已启用',liveMonitoring:true,targets:[{chatId:'-1001',threadId:8},{platform:'discord',guildId:'g',channelId:'c'}]};
const broadcast={platform:'YouTube',ownerId:'UC123',id:'live1',title:'Live market',url:'https://www.youtube.com/watch?v=live1',state:'live',startedAt:'2026-09-08T08:00:00Z'};
function repo(){const data=new Map();return {getMeta:async k=>data.get(k)||null,setMeta:async(k,v)=>{data.set(k,structuredClone(v));return v;},compareAndSetMeta:async(k,e,v)=>{const c=data.get(k);if(e.absent?!!c:Object.entries(e).some(([f,x])=>c?.[f]!==x))return null;data.set(k,structuredClone(v));return v;},acquireMetaLease:async(k,v,n)=>{if(Date.parse(data.get(k)?.leaseUntil)>n.getTime())return null;data.set(k,v);return v;},releaseMetaLease:async(k,id)=>{if(data.get(k)?.leaseId===id)data.delete(k);},listMetaByPrefix:async p=>[...data].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value}))};}
const detect=async()=>({broadcasts:[broadcast],provider:'YouTube Live'});
function options(repository,deliver,extra={}){return {repository,loadSources:async()=>[source],detect,deliver,env:{YOUTUBE_API_KEY:'test'},now:new Date('2026-09-08T08:05:00Z'),...extra};}
test('same broadcast is delivered once per target across concurrent checks and restarts',async()=>{const repository=repo();const sent=[];const opts=options(repository,async event=>{sent.push(event.target);return {status:'success',messageId:'42'};});await Promise.all([runSocialLiveMonitor(opts),runSocialLiveMonitor(opts)]);await runSocialLiveMonitor({...opts,now:new Date('2026-09-08T08:31:00Z')});assert.equal(sent.length,2);});
test('one uncertain target never resends successful or uncertain targets automatically',async()=>{const repository=repo();let calls=0;const opts=options(repository,async({target})=>{calls++;if(target.platform==='discord')throw new Error('network timeout');return {status:'success',messageId:'10'};});const first=await runSocialLiveMonitor(opts);assert.equal(first.status,'partial');await runSocialLiveMonitor({...opts,now:new Date('2026-09-08T08:31:00Z')});assert.equal(calls,2);assert.equal((await repository.getMeta(liveDeliveryKey(broadcast,source.targets[1]))).status,'manual-reconciliation');});
test('paused, non-opted-in, and unknown provider results never send',async()=>{let sent=0;await runSocialLiveMonitor(options(repo(),async()=>{sent++},{loadSources:async()=>[{...source,status:'已暂停'},{...source,id:'s2',liveMonitoring:false}]}));const failed=await runSocialLiveMonitor(options(repo(),async()=>{sent++},{detect:async()=>{throw new Error('provider unavailable')}}));assert.equal(failed.status,'failed');assert.equal(sent,0);});
test('read-only preview cannot change monitor state or trigger notifications',async()=>{const repository=repo();let sent=0;const result=await runSocialLiveMonitor(options(repository,async()=>{sent++},{dryRun:true}));assert.equal(result.sources[0].state,'live');assert.equal(sent,0);assert.deepEqual(await repository.listMetaByPrefix('social-live:'),[]);});
test('pausing a source during a network check prevents its alert',async()=>{let n=0,sent=0;await runSocialLiveMonitor(options(repo(),async()=>{sent++},{loadSources:async()=>[++n===1?source:{...source,status:'已暂停'}]}));assert.equal(sent,0);});
test('an ended stream invalidates pending desktop alerts instead of publishing old notices',async()=>{const repository=repo();const canceled=[];const opts=options(repository,async()=>({status:'queued',deliveryId:'queue1'}));await runSocialLiveMonitor(opts);await runSocialLiveMonitor({...opts,now:new Date('2026-09-08T08:31:00Z'),detect:async()=>({broadcasts:[]}),cancelQueued:async id=>canceled.push(id)});assert.deepEqual(canceled,['queue1','queue1']);});
test('duplicate source configurations share broadcast and target receipt identity',async()=>{const repository=repo();let sent=0;await runSocialLiveMonitor(options(repository,async()=>{sent++;return {status:'success',messageId:'1'}},{loadSources:async()=>[source,{...source,id:'duplicate'}]}));assert.equal(sent,2);});
test('pausing an existing source cancels its still pending desktop notice without provider calls',async()=>{
 const repository=repo();let checks=0;const canceled=[];await runSocialLiveMonitor(options(repository,async()=>({status:'queued',deliveryId:'queue1'})));
 await runSocialLiveMonitor(options(repository,async()=>{throw new Error('must not send')},{loadSources:async()=>[{...source,status:'已暂停'}],detect:async()=>{checks++;return {broadcasts:[]}},cancelQueued:async id=>canceled.push(id)}));assert.equal(checks,0);assert.equal(canceled.length,2);
});
test('platform receipt settlement updates queued notices to success',async()=>{
 const repository=repo();await runSocialLiveMonitor(options(repository,async()=>({status:'queued',deliveryId:'queue1'})));repository.getDelivery=async()=>({status:'success',targetMessageId:'300'});
 await runSocialLiveMonitor(options(repository,async()=>{throw new Error('must not repeat')},{now:new Date('2026-09-08T08:31:00Z')}));assert.equal((await repository.getMeta(liveDeliveryKey(broadcast,source.targets[0]))).status,'success');
});

test('YouTube discovery leaves daily search quota headroom while X retains five-minute checks',async()=>{
 const youtube={...source,targets:[]};const x={...source,id:'x1',platform:'X',accountUrl:'https://x.com/academy',targets:[]};
 const repository=repo();const calls=[];const opts={repository,loadSources:async()=>[youtube,x],detect:async s=>{calls.push(s.id);return {broadcasts:[],provider:s.platform}},now:'2026-09-08T08:00:00Z'};
 await runSocialLiveMonitor(opts);await runSocialLiveMonitor({...opts,now:'2026-09-08T08:05:00Z'});await runSocialLiveMonitor({...opts,now:'2026-09-08T08:20:00Z'});
 assert.deepEqual(calls,['s1','x1','x1','s1','x1']);
 const states=await getSocialLiveStatus([youtube,x],{repository,env:{}});assert.equal(states[0].intervalMinutes,20);assert.equal(states[1].intervalMinutes,5);
});

test('YouTube interval accounts for all active sources and ignores paused or disabled ones',async()=>{
 const sources=[source,{...source,id:'s2'},{...source,id:'paused',status:'已暂停'},{...source,id:'disabled',liveMonitoring:false}];
 const states=await getSocialLiveStatus(sources,{repository:repo(),env:{}});assert.equal(states[0].intervalMinutes,40);assert.equal(states[1].intervalMinutes,40);
 assert.ok(sources.filter(s=>s.status==='已启用'&&s.liveMonitoring).length*1440/states[0].intervalMinutes<100);
});
