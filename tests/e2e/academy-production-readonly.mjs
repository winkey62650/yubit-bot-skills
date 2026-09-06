import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const base=process.env.ACADEMY_READONLY_URL;
assert.ok(base&&new URL(base).protocol==='https:','Provide explicit HTTPS production origin');
const values={};for(const line of (await readFile(process.env.ACADEMY_AUTH_FILE,'utf8')).split('\n')){const m=line.match(/^([A-Z_]+)=(.*)$/);if(m)values[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1366,height:900}});
const login=await context.request.post(base+'/api/auth/login',{data:{username:values.AUTH_USERNAME,password:values.AUTH_PASSWORD}});
assert.equal(login.status(),200);
// Block all state-changing browser requests, including any accidental clicks.
await context.route('**/*',route=>['GET','HEAD'].includes(route.request().method())?route.continue():route.abort('blockedbyclient'));
const routes=(await readdir('app',{recursive:true})).filter(p=>p.endsWith('page.jsx')&&!p.includes('[')).map(p=>'/'+p.replace(/\/?page.jsx$/,''));
routes.push(...['site-analytics','automation','destination-cta','broadcast','review','logs'].map(view=>`/distribution?view=${view}`));
const report=[];
for(const route of routes){
 const page=await context.newPage();const errors=[],failedApis=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.status()>=400&&r.url().includes('/api/'))failedApis.push({path:new URL(r.url()).pathname,status:r.status()})});
 try{const response=await page.goto(base+route,{waitUntil:'networkidle',timeout:25000});report.push({route,status:response.status(),finalPath:new URL(page.url()).pathname,heading:await page.locator('h1').allTextContents(),errors,failedApis});}
 catch(e){report.push({route,error:e.message,errors,failedApis});}
 console.log(JSON.stringify(report.at(-1)));await page.close();
}
await mkdir('docs/qa',{recursive:true});await writeFile('docs/qa/production-readonly.json',JSON.stringify(report,null,2));
await browser.close();
assert.ok(report.every(r=>r.status===200&&!r.error&&!r.errors.length),'Production read-only scan has failures');
