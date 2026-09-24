import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonDistributionRepository} from '../lib/distribution-repository.mjs';
import {runSocialPostMonitor,deliverSocialPost} from '../lib/social-post-monitor.mjs';
import {retryDistributionDelivery} from '../lib/distribution-service.mjs';
const source={id:'ajc',name:'Average Joe Crypto YouTube',agent:'Average Joe Crypto',platform:'YouTube',accountUrl:'https://youtube.com/channel/UC123',status:'已启用',postMonitoring:true,postSyncMode:'verified',targets:[{platform:'discord',guildId:'g',channelId:'updates'}]};
const post={platform:'YouTube',ownerId:'UC123',id:'video123',title:'New video',description:'Daily crypto overview.',url:'https://youtu.be/video123',publishedAt:'2026-09-14T02:01:00Z'};
test('real repository persists one Discord receipt across restart; old notices cannot be replayed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'social-post-'));const previous=process.env.JSON_STORE_DIRECTORY;process.env.JSON_STORE_DIRECTORY=dir;
 try{
  let repository=new JsonDistributionRepository();let sent=0;const options={loadSources:async()=>[source],fetchPosts:async()=>({ownerId:post.ownerId,posts:[post]}),deliver:args=>deliverSocialPost({...args,discordSender:async(channel,payload)=>{sent++;assert.equal(channel,'updates');assert.match(payload.content,/New video · Mon 14th September/);assert.match(payload.content,/Click here to watch the video/);return {id:'123'}}})};
  await runSocialPostMonitor({...options,repository,now:'2026-09-14T02:00:00Z'});assert.equal(sent,0);
  await runSocialPostMonitor({...options,repository,now:'2026-09-14T02:05:00Z'});
  repository=new JsonDistributionRepository();await runSocialPostMonitor({...options,repository,now:'2026-09-14T02:10:00Z'});assert.equal(sent,1);
  const [delivery]=await repository.listDeliveries();assert.equal(delivery.targetMessageId,'123');assert.equal(delivery.attempts,1);assert.equal(delivery.payload.socialPostSourceId,'ajc');
  await retryDistributionDelivery(delivery.id,{repository});assert.equal(sent,1,'successful receipt is returned without replay');
  await repository.updateDelivery(delivery.id,{status:'manual-reconciliation'});
  assert.equal((await retryDistributionDelivery(delivery.id,{repository})).status,'manual-reconciliation');
  await repository.updateDelivery(delivery.id,{status:'failed'});
  await assert.rejects(retryDistributionDelivery(delivery.id,{repository}),/社媒/);
  const event=await repository.getEvent(delivery.eventId);assert.equal(event.payload.post.id,post.id);assert.equal((await repository.getRule(delivery.ruleId)).enabled,false);
 }finally{if(previous===undefined)delete process.env.JSON_STORE_DIRECTORY;else process.env.JSON_STORE_DIRECTORY=previous;await rm(dir,{recursive:true,force:true});}
});
