import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchSocialPosts,renderPostNotice} from '../lib/social-post-sources.mjs';
const yt={platform:'YouTube',accountUrl:'https://youtube.com/channel/UC123',agent:'Average Joe Crypto'};
const response=data=>Response.json(data);
const video=(id,extra={})=>({id,snippet:{channelId:'UC123',title:'New analysis',description:'A full crypto overview for today.',publishedAt:'2026-09-14T02:00:00Z',liveBroadcastContent:'none'},...extra});
test('ordinary YouTube videos use official ownership and exclude scheduled, current, and archived livestreams',async()=>{
 const result=await fetchSocialPosts(yt,{env:{YOUTUBE_API_KEY:'test'},fetchImpl:async url=>{
  if(url.includes('/channels?'))return response({items:[{id:'UC123',contentDetails:{relatedPlaylists:{uploads:'UU123'}}}]});
  if(url.includes('/playlistItems?'))return response({items:['regular0001','replay00001','live0000001','future00001'].map(videoId=>({snippet:{channelId:'UC123'},contentDetails:{videoId}}))});
  assert.ok(url.includes('/videos?'));return response({items:[video('regular0001'),video('replay00001',{liveStreamingDetails:{actualStartTime:'2026-09-14T00:00:00Z',actualEndTime:'2026-09-14T01:00:00Z'}}),video('live0000001',{snippet:{...video('x').snippet,liveBroadcastContent:'live'}}),video('future00001',{snippet:{...video('x').snippet,liveBroadcastContent:'upcoming'}})]});
 }});assert.deepEqual(result.posts.map(p=>p.id),['regular0001']);assert.equal(result.excludedLiveCount,3);
});
test('YouTube ordinary monitoring rejects wrong ownership and never substitutes a feed title',async()=>{
 await assert.rejects(fetchSocialPosts(yt,{env:{YOUTUBE_API_KEY:'test'},fetchImpl:async()=>response({items:[{id:'OTHER',contentDetails:{relatedPlaylists:{uploads:'UUOTHER'}}}]})}),/归属/);
});
test('X public fallback returns multiple own original posts without leaking the API token',async()=>{
 const markdown='[one](https://x.com/AvrgJoeCrypto/status/2099320669901119724) First post\n[two](https://x.com/AvrgJoeCrypto/status/2099320669901119725) Second post\n[reply](https://x.com/AvrgJoeCrypto/status/2099320669901119726) @someone Thanks\n[foreign](https://x.com/Other/status/2099320669901119727) Foreign post';
 const result=await fetchSocialPosts({platform:'X',accountUrl:'https://x.com/AvrgJoeCrypto'},{env:{X_BEARER_TOKEN:'private'},fetchImpl:async(url,init)=>{
  if(url.startsWith('https://api.x.com/'))return new Response('no credits',{status:402});assert.equal(init.headers.authorization,undefined);return new Response(markdown);
 }});assert.equal(result.strategy,'x-reader-fallback');assert.equal(result.posts.length,2);assert.ok(result.posts.every(p=>p.ownerId==='avrgjoecrypto'));assert.ok(result.warning);
});
test('X official timeline checks author identity and returns every original in the response',async()=>{
 const result=await fetchSocialPosts({platform:'X',accountUrl:'https://x.com/AvrgJoeCrypto'},{env:{X_BEARER_TOKEN:'test'},fetchImpl:async url=>url.includes('/by/username/')?response({data:{id:'123',username:'AvrgJoeCrypto'}}):response({data:[{id:'2099320669901119724',author_id:'123',text:'First',created_at:'2026-09-14T02:00:00Z'},{id:'2099320669901119725',author_id:'123',text:'Second',created_at:'2026-09-14T02:01:00Z'}]})});assert.equal(result.posts.length,2);assert.equal(result.strategy,'x-api');
});
test('YouTube notices follow the reference layout without triggering mass mentions',()=>{
 const card=renderPostNotice({agent:'Average Joe Crypto'},{platform:'YouTube',id:'regular0001',title:'中文直播 @everyone',description:'A full crypto overview for today.',url:'https://evil.test',publishedAt:'2026-09-14T02:00:00Z'});assert.doesNotMatch(JSON.stringify(card),/[\u3400-\u9fff]|evil/);assert.equal(card.embeds[0].url,'https://www.youtube.com/watch?v=regular0001');assert.equal(card.embeds[0].image.url,'https://i.ytimg.com/vi/regular0001/hqdefault.jpg');assert.match(card.content,/Average Joe Crypto \| YouTube/);assert.match(card.content,/Mon 14th September/);assert.match(card.content,/Click here to watch the video/);assert.match(card.content,/@everyone/);assert.deepEqual(card.allowedMentions,{parse:[]});
});
