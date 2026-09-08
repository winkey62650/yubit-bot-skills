import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const helper=fileURLToPath(new URL('../scripts/install-social-live-credentials.py',import.meta.url));
const token='AAAA-test-social-live-credential-only';
async function fixture(run){const dir=await mkdtemp(join(tmpdir(),'live-credentials-'));try{const file=join(dir,'production.env');await writeFile(file,'AUTH_SECRET=existing\nX_BEARER_TOKEN=old\nYOUTUBE_API_KEY=keep\nALLOW_LIVE_TELEGRAM=false\n',{mode:0o600});await run(file,dir);}finally{await rm(dir,{recursive:true,force:true});}}
const invoke=(file,data)=>spawnSync('python3',[helper,'--env-file',file],{input:JSON.stringify(data),encoding:'utf8'});
test('credential install preserves unrelated policy and absent provider values without logging secrets',async()=>fixture(async file=>{const r=invoke(file,{X_BEARER_TOKEN:token,YOUTUBE_API_KEY:''});assert.equal(r.status,0,r.stderr);assert.equal(await readFile(file,'utf8'),`AUTH_SECRET=existing\nX_BEARER_TOKEN=${token}\nYOUTUBE_API_KEY=keep\nALLOW_LIVE_TELEGRAM=false\n`);assert.equal((await stat(file)).mode&0o777,0o600);assert.ok(!r.stdout.includes(token)&&!r.stderr.includes(token));}));
test('credential installer rejects unexpected settings and newline injection without modifying the environment',async()=>fixture(async file=>{const before=await readFile(file,'utf8');for(const data of [{X_BEARER_TOKEN:token,ALLOW_LIVE_TELEGRAM:'true'},{X_BEARER_TOKEN:token+'\nALLOW_LIVE_TELEGRAM=true'},{X_BEARER_TOKEN:''}]){assert.notEqual(invoke(file,data).status,0);assert.equal(await readFile(file,'utf8'),before);}}));
test('credential installer does not follow a symlinked environment file',async()=>fixture(async(file,dir)=>{const link=join(dir,'alias.env');await symlink(file,link);assert.notEqual(invoke(link,{X_BEARER_TOKEN:token}).status,0);assert.ok(!(await readFile(file,'utf8')).includes(token));}));
test('credential install replaces duplicate provider entries once and is idempotent',async()=>fixture(async file=>{await writeFile(file,'# policy\nX_BEARER_TOKEN=old\nX_BEARER_TOKEN=duplicate\n');assert.equal(invoke(file,{X_BEARER_TOKEN:token}).status,0);const first=await readFile(file,'utf8');assert.equal(first.split('X_BEARER_TOKEN=').length-1,1);assert.equal(invoke(file,{X_BEARER_TOKEN:token}).status,0);assert.equal(await readFile(file,'utf8'),first);}));
