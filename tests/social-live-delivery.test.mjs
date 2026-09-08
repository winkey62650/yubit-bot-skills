import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonDistributionRepository } from '../lib/distribution-repository.mjs';
import { deliverSocialLiveNotice, cancelSocialLiveDelivery } from '../lib/social-live-delivery.mjs';
import { claimDesktopPublisherDelivery, retryDistributionDelivery } from '../lib/distribution-service.mjs';
const target={chatId:'-1003710405969',threadId:8,topicName:'Market Events',groupName:'DEMO Academy'};
const live={id:'live1',platform:'YouTube',ownerId:'UC123',title:'Live',url:'https://youtube.com/watch?v=live1'};
const env={TELEGRAM_DEMO_ONLY:'true',TELEGRAM_PUBLISHER_MODE:'user',TELEGRAM_DESKTOP_PUBLISHER_REQUIRED:'true',TELEGRAM_USER_PUBLISHER_TARGETS:'-1003710405969'};

test('live notices use durable desktop plans, preserve exact target, and expire instead of sending late',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'social-live-'));const previous=process.env.JSON_STORE_DIRECTORY;process.env.JSON_STORE_DIRECTORY=dir;
 try {
  const repository=new JsonDistributionRepository();let sent=0;
  const args={source:{id:'s',agent:'Academy'},live,target,text:'Live notice',receiptKey:'one',now:new Date(Date.now()-11*60_000),repository,env,telegramSender:async()=>{sent++;return {message_id:1}}};
  const first=await deliverSocialLiveNotice(args);const second=await deliverSocialLiveNotice(args);
  assert.equal(first.status,'queued');assert.equal(first.deliveryId,second.deliveryId);assert.equal(sent,0);
  const row=await repository.getDelivery(first.deliveryId);const event=await repository.getEvent(row.eventId);
  assert.equal(event.payload.deliveryPlans[0].steps[0].payload.message_thread_id,8);
  assert.equal((await repository.getRule(row.ruleId)).enabled,false);
  assert.equal(await claimDesktopPublisherDelivery({repository,env}),null);
  assert.equal((await repository.getDelivery(first.deliveryId)).status,'failed');
  await assert.rejects(retryDistributionDelivery(first.deliveryId,{repository,env}),/直播/);
 } finally {if(previous===undefined)delete process.env.JSON_STORE_DIRECTORY;else process.env.JSON_STORE_DIRECTORY=previous;await rm(dir,{recursive:true,force:true});}
});
test('Discord live delivery is confirmed once and an unconfirmed send cannot be replayed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'social-live-discord-'));const previous=process.env.JSON_STORE_DIRECTORY;process.env.JSON_STORE_DIRECTORY=dir;
 try {const repository=new JsonDistributionRepository();let calls=0;const args={source:{id:'s'},live,target:{platform:'discord',guildId:'g',channelId:'c'},text:'Live notice',receiptKey:'discord',now:new Date(),repository,env,discordSender:async()=>{calls++;return {id:'123'}}};const a=await deliverSocialLiveNotice(args);assert.equal(a.status,'success');await deliverSocialLiveNotice(args);assert.equal(calls,1);
 const broken={...args,receiptKey:'uncertain',discordSender:async()=>{calls++;throw new Error('timeout')}};await assert.rejects(deliverSocialLiveNotice(broken));await assert.rejects(deliverSocialLiveNotice(broken));assert.equal(calls,2);
 }finally{if(previous===undefined)delete process.env.JSON_STORE_DIRECTORY;else process.env.JSON_STORE_DIRECTORY=previous;await rm(dir,{recursive:true,force:true});}
});
test('canceling a pending notification cannot cancel an already claimed desktop send',async()=>{let updated=0;const repository={getDelivery:async()=>({status:'pending'}),claimDelivery:async()=>null,updateDelivery:async()=>{updated++}};assert.equal(await cancelSocialLiveDelivery('id',{repository}),false);assert.equal(updated,0);});
