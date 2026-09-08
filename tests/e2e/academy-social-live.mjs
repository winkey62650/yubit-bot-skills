import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir,writeFile } from 'node:fs/promises';
const base=process.env.ACADEMY_LIVE_QA_URL || 'http://localhost:3218';
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Local QA only');
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1366,height:900}});
const report={routes:[],errors:[],checks:{}};
const source={id:'qa-live',name:'QA Live YouTube',agent:'QA Academy',platform:'YouTube',accountUrl:'https://youtube.com/@qa_academy',status:'已启用',targets:[{chatId:'-1003710405969',threadId:8,groupName:'QA DEMO',topicName:'Market Events'}]};
try {
 const login=await context.request.post(base+'/api/auth/login',{data:{username:'audit',password:'local-audit-only'}});assert.equal(login.status(),200);
 const saved=await context.request.post(base+'/api/social-packages',{data:{action:'upsert',source}});assert.equal(saved.status(),200);
 assert.equal((await saved.json()).packages.find(s=>s.id===source.id).liveMonitoring,false,'Legacy source unexpectedly enabled live alerts');
 await context.route('**/api/group-config',r=>r.fulfill({json:{ok:true,groups:[{chatId:'-1003710405969',title:'QA DEMO',topics:[{threadId:8,name:'Market Events'}]}]}}));
 await context.route('**/api/discord',r=>r.fulfill({json:{ok:true,connected:false,config:{guilds:{}},guilds:[],health:{summary:{},guilds:[]},result:{health:{summary:{},guilds:[]}}}}));
 await context.route('**/api/destination-cta',r=>r.fulfill({json:{ok:true,registry:{}}}));
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(base+'/distribution?view=automation');
 await page.locator('select').filter({has:page.locator('option[value="agent-sync"]')}).selectOption('agent-sync');
 await page.getByRole('heading',{name:'X / YouTube 帖子与直播',exact:true}).waitFor();
 await page.locator('article').filter({hasText:source.name}).getByRole('button',{name:'编辑',exact:true}).click();
 await page.getByRole('checkbox',{name:'监控普通帖子',exact:false}).uncheck();
 await page.getByRole('checkbox',{name:'监控直播开播',exact:false}).check();
 await page.getByRole('button',{name:'保存来源',exact:true}).click();
 await page.getByText(/QA Live YouTube · 直播接口未就绪/).waitFor();
 await page.getByText('每 5 分钟检查 · 英文开播提醒 · 同场去重',{exact:true}).waitFor();
 const state=await (await context.request.get(base+'/api/social-packages')).json();
 assert.equal(state.packages.find(s=>s.id===source.id).liveMonitoring,true);
 assert.equal(state.packages.find(s=>s.id===source.id).postMonitoring,false);
 assert.equal(state.packages.find(s=>s.id===source.id).targets[0].threadId,8);
 await page.reload();await page.locator('select').filter({has:page.locator('option[value="agent-sync"]')}).selectOption('agent-sync');
 await page.locator('article').filter({hasText:source.name}).getByRole('button',{name:'编辑',exact:true}).click();
 assert.equal(await page.getByRole('checkbox',{name:'监控直播开播',exact:false}).isChecked(),true);
 assert.equal(await page.getByRole('checkbox',{name:'监控普通帖子',exact:false}).isChecked(),false);
 const missing=await context.request.post(base+'/api/social-live',{data:{action:'test',source}});assert.equal(missing.status(),422);assert.match((await missing.json()).error,/YOUTUBE_API_KEY/);
 await page.route('**/api/social-live',r=>r.request().method()==='POST'?r.fulfill({json:{ok:true,preview:{provider:'YouTube Live',broadcasts:[{id:'qa-live',title:'QA market live',url:'https://youtube.com/watch?v=qa-live'}],scheduledCount:0}}}):r.continue());
 await page.getByRole('button',{name:'检测直播状态（不发送）',exact:true}).click();
 await page.getByText('检测到 1 场正在直播',{exact:true}).waitFor();
 assert.equal(await page.getByRole('link',{name:'QA market live'}).getAttribute('href'),'https://youtube.com/watch?v=qa-live');
 for(const route of ['/distribution?view=automation','/discord/distribution']) {
  if(route.includes('discord')){await page.goto(base+route);await page.getByRole('heading',{name:'X / YouTube 帖子与直播',exact:true}).waitFor();}
  for(const width of [1366,768,390]){await page.setViewportSize({width,height:900});const clipped=await page.evaluate(()=>[...document.querySelectorAll('main input,main button,main select,main textarea')].filter(e=>{const r=e.getBoundingClientRect();for(let parent=e.parentElement;parent&&parent.tagName!=='MAIN';parent=parent.parentElement){if(['auto','scroll'].includes(getComputedStyle(parent).overflowX))return false;}return r.width>0&&(r.right>innerWidth+1||r.left< -1)}).map(e=>e.tagName));report.routes.push({route,width,clipped});assert.equal(clipped.length,0,route+' clipped controls');}
 }
 const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(base+'/api/social-live')).status(),401);await anonymous.close();
 const manual=await browser.newContext();assert.equal((await manual.request.post(base+'/api/auth/login',{data:{username:'manual-audit',password:'manual-local-audit'}})).status(),200);assert.equal((await manual.request.get(base+'/api/social-live')).status(),403);await manual.close();
 assert.equal(report.errors.length,0);report.checks={legacyDefaultOff:true,liveOnlyPersists:true,persistAndReload:true,targetsPreserved:true,missingCredentials422:true,readOnlyLivePreview:true,anonymous401:true,manualPublisher403:true};report.outcome='passed';
} catch(e){report.outcome='failed';report.error=e.message;throw e;}
finally{await mkdir('docs/qa',{recursive:true});await writeFile('docs/qa/social-live-browser.json',JSON.stringify(report,null,2));await browser.close();}
