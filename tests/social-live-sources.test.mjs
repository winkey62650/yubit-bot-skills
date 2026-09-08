import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSocialLive, liveProviderStatus } from '../lib/social-live-sources.mjs';
const yt={id:'yt',agent:'Academy',platform:'YouTube',accountUrl:'https://www.youtube.com/@academy'};
const x={id:'x',agent:'Academy',platform:'X',accountUrl:'https://x.com/academy'};
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});

test('live credentials are required; ordinary social feeds do not prove live status', async()=>{
 assert.equal(liveProviderStatus(yt,{}).ready,false);
 await assert.rejects(detectSocialLive({...yt,feedUrl:'https://example.org/post.xml'},{env:{}}),/YOUTUBE_API_KEY/);
 await assert.rejects(detectSocialLive(x,{env:{}}),/X_BEARER_TOKEN/);
});
test('YouTube resolves the configured owner and verifies actual started broadcasts', async()=>{
 const calls=[];const fetchImpl=async(url)=>{const u=new URL(url);calls.push(u);if(u.pathname.endsWith('/channels'))return json({items:[{id:'UC123'}]});if(u.pathname.endsWith('/search'))return json({items:[{id:{videoId:'live1'}},{id:{videoId:'ended'}}]});return json({items:[{id:'live1',snippet:{channelId:'UC123',title:'Market Live',liveBroadcastContent:'live'},liveStreamingDetails:{actualStartTime:'2026-09-08T08:00:00Z'}},{id:'ended',snippet:{channelId:'UC123',title:'Replay',liveBroadcastContent:'none'},liveStreamingDetails:{actualStartTime:'2026-09-08T07:00:00Z',actualEndTime:'2026-09-08T07:30:00Z'}}]});};
 const result=await detectSocialLive(yt,{env:{YOUTUBE_API_KEY:'private-key'},fetchImpl});
 assert.equal(result.broadcasts.length,1);assert.equal(result.broadcasts[0].id,'live1');assert.equal(result.broadcasts[0].url,'https://www.youtube.com/watch?v=live1');
 assert.equal(calls[0].searchParams.get('forHandle'),'@academy');assert.equal(calls[1].searchParams.get('eventType'),'live');assert.equal(calls[1].searchParams.get('channelId'),'UC123');
});
test('YouTube rejects a different creator instead of sharing unrelated live content',async()=>{
 await assert.rejects(detectSocialLive({...yt,accountUrl:'https://youtube.com/channel/UC123'},{env:{YOUTUBE_API_KEY:'key'},fetchImpl:async url=>new URL(url).pathname.endsWith('/search')?json({items:[{id:{videoId:'bad'}}]}):json({items:[{id:'bad',snippet:{channelId:'OTHER',title:'live',liveBroadcastContent:'live'},liveStreamingDetails:{actualStartTime:'2026-09-08T08:00:00Z'}}]})}),/归属/);
});
test('X Spaces only emits live Spaces created by the configured account',async()=>{
 const result=await detectSocialLive(x,{env:{X_BEARER_TOKEN:'private-token'},fetchImpl:async(url,options)=>{assert.equal(options.headers.authorization,'Bearer private-token');return new URL(url).pathname.includes('/users/')?json({data:{id:'123',username:'academy'}}):json({data:[{id:'ABC123',creator_id:'123',state:'live',title:'Market talk',started_at:'2026-09-08T08:00:00Z'},{id:'DEF456',creator_id:'123',state:'scheduled',title:'Tomorrow'},{id:'GHI789',creator_id:'999',state:'live',title:'Guest Space'}]});}});
 assert.equal(result.broadcasts.length,1);assert.equal(result.broadcasts[0].url,'https://x.com/i/spaces/ABC123');assert.equal(result.scheduledCount,1);
});
test('upstream denial is an error, not offline, and cannot disclose credentials',async()=>{
 await assert.rejects(detectSocialLive(x,{env:{X_BEARER_TOKEN:'secret'},fetchImpl:async()=>new Response('secret provider diagnostic',{status:429})}),err=>err.message.includes('429')&&!err.message.includes('secret'));
});
test('account URLs cannot redirect credentialed probes to arbitrary hosts',async()=>{
 let calls=0;await assert.rejects(detectSocialLive({...yt,accountUrl:'https://youtube.com.attacker.example/@academy'},{env:{YOUTUBE_API_KEY:'secret'},fetchImpl:async()=>{calls++;return json({});}}),/账号/);assert.equal(calls,0);
});
test('existing HTTP YouTube profile URLs are identifiers only; all API calls remain HTTPS',async()=>{
 const urls=[];await detectSocialLive({...yt,accountUrl:'http://www.youtube.com/@WISEADVICEE'},{env:{YOUTUBE_API_KEY:'key'},fetchImpl:async u=>{urls.push(new URL(u));return u.includes('/channels')?json({items:[{id:'UC123'}]}):json({items:[]});}});assert.ok(urls.every(u=>u.protocol==='https:'&&u.hostname==='www.googleapis.com'));assert.equal(urls[0].searchParams.get('forHandle'),'@WISEADVICEE');
});
test('X requests creator expansion and treats malformed missing data as unknown',async()=>{
 const queries=[];const fetchImpl=async u=>{queries.push(new URL(u));return u.includes('/users/')?json({data:{id:'123',username:'academy'}}):json({});};await assert.rejects(detectSocialLive(x,{env:{X_BEARER_TOKEN:'key'},fetchImpl}),/格式/);assert.equal(queries[1].searchParams.get('expansions'),'creator_id');assert.ok(!queries[1].searchParams.get('space.fields').split(',').includes('creator_id'));
});
