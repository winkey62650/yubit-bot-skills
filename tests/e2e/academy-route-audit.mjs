import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
const base=process.env.ACADEMY_AUDIT_URL||'http://127.0.0.1:3217';
assert.ok(['127.0.0.1','localhost'].includes(new URL(base).hostname));
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1366,height:900}});
await context.request.post(`${base}/api/auth/login`,{data:{username:'audit',password:'local-audit-only'}});
const routes=(await readdir('app',{recursive:true})).filter(p=>p.endsWith('page.jsx')).map(p=>'/'+p.replace(/\/?page.jsx$/,'').replace('[release]','us-cpi').replace('[date]','2026-08-12').replace('[week]','2026-W34'));
routes.push(...['site-analytics','automation','destination-cta','broadcast','review','logs'].map(v=>`/distribution?view=${v}`));
const report=[];
for(const route of routes){
 const page=await context.newPage(); const errors=[]; const failedApis=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.status()>=400&&r.url().includes('/api/'))failedApis.push({url:new URL(r.url()).pathname,status:r.status()})});
 try{
  const response=await page.goto(base+route,{timeout:30000,waitUntil:'networkidle'});
  const heading=await page.locator('h1').allTextContents();
  const body=await page.locator('main').innerText().catch(()=>page.locator('body').innerText());
  const responsive=[];
  for(const width of [1366,768,390]){
    await page.setViewportSize({width,height:900});
    responsive.push(await page.evaluate(()=>{
      const clipped=[...document.querySelectorAll('main button,main input,main select,main textarea')].filter(element=>{
        const rect=element.getBoundingClientRect();
        if(!rect.width||!rect.height||rect.right<=innerWidth) return false;
        for(let parent=element.parentElement;parent&&parent.tagName!=='MAIN';parent=parent.parentElement){if(['auto','scroll'].includes(getComputedStyle(parent).overflowX)) return false;}
        return true;
      }).map(e=>({tag:e.tagName,label:(e.textContent||e.placeholder||e.getAttribute('aria-label')||'').slice(0,70)}));
      return {width:innerWidth,clipped};
    }));
  }
  await page.setViewportSize({width:1366,height:900});
  const tabs=await page.getByRole('tab').allTextContents();
  for(const label of tabs){await page.getByRole('tab',{name:label,exact:true}).click();}
  report.push({route,status:response.status(),finalPath:new URL(page.url()).pathname,heading,tabs,errors,failedApis,responsive,empty:body.length<15});
 }catch(e){report.push({route,error:e.message,errors,failedApis});}
 console.log(JSON.stringify(report.at(-1)));
 await page.close();
}
await mkdir('docs/qa',{recursive:true});
await writeFile('docs/qa/route-audit.json',JSON.stringify(report,null,2));
const publicPage=await browser.newPage();
for(const path of ['/market-calendar/2026-W34','/data-updates/us-cpi/2026-08-12']){
 const response=await publicPage.goto(base+path);
 assert.equal(response.status(),200);
 assert.equal(new URL(publicPage.url()).pathname,path);
 assert.ok((await publicPage.locator('h1').innerText()).startsWith('QA FIXTURE'));
}
const protectedApi=await publicPage.request.get(base+'/api/composer/target-folders');
assert.equal(protectedApi.status(),401);
console.log('Public articles open without login; admin API remains protected');
await browser.close();
assert.ok(report.every(item=>item.status===200&&!item.error&&!item.errors.length),'Every page must render without runtime errors');

assert.ok(report.every(item=>item.responsive.every(view=>view.clipped.length===0)),'Every form control must fit its viewport');
