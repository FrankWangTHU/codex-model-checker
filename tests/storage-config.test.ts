import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProxyConfig} from '../src/main/config';
import {Store} from '../src/main/store';
import {entry} from './helpers';
test('proxy config backs up and restores exactly; preserves unrelated edits',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cmc-config-')),file=join(dir,'config.toml'),config=new ProxyConfig(file,dir);
  const original='model = "gpt-6-astra"\n\n[features]\nfoo = true\n';writeFileSync(file,original);
  config.enable(43822);assert.match(readFileSync(file,'utf8'),/127\.0\.0\.1:43822/);assert.ok(config.backup());config.restore();assert.equal(readFileSync(file,'utf8'),original);assert.equal(config.backup(),null);
  config.enable(43822);writeFileSync(file,readFileSync(file,'utf8')+'bar = false\n');config.restore();assert.match(readFileSync(file,'utf8'),/bar = false/);assert.ok(!readFileSync(file,'utf8').includes('127.0.0.1'));
});
test('restores a previously absent config; rejects unsupported providers and changed endpoint',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cmc-config-')),file=join(dir,'config.toml'),config=new ProxyConfig(file,dir);
  config.enable(43822);config.restore();assert.equal(existsSync(file),false);
  writeFileSync(file,'model_provider = "custom"\n');assert.throws(()=>config.enable(43822),/自定义/);assert.equal(config.backup(),null);
  writeFileSync(file,'model="gpt-6-astra"\n');config.enable(43822);writeFileSync(file,readFileSync(file,'utf8').replace(':43822',':9999'));assert.throws(()=>config.restore(),/已被修改/);assert.ok(config.backup());
});
test('nested upstream config is not removed by top-level override',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cmc-config-')),file=join(dir,'config.toml'),config=new ProxyConfig(file,dir);
  const original='[profiles.test]\nopenai_base_url="https://example.org/v1"\n';writeFileSync(file,original);config.enable(43822);assert.ok(readFileSync(file,'utf8').includes(original));config.restore();
});
test('storage enforces retention, strips private input and alerts only once even after conflict/restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cmc-store-'));const store=new Store(dir);let alerts=0;store.on('alert',()=>alerts++);
  const bad=entry({candidates:[{field:'response.model',model:'gpt-6-luna',kind:'route'}]});store.upsert(bad);store.upsert(bad);store.upsert({...bad,candidates:[...bad.candidates,{field:'model',model:'gpt-6-astra',kind:'route'}]});store.upsert(bad);assert.equal(alerts,1);
  store.upsert(entry({id:'old',time:Date.now()-32*86400000}));assert.equal(store.records.length,1);store.flush();
  const loaded=new Store(dir);loaded.on('alert',()=>alerts++);loaded.upsert(bad);assert.equal(alerts,1);loaded.flush();loaded.clear();assert.equal(new Store(dir).records.length,0);
  writeFileSync(join(dir,'records.json'),JSON.stringify([entry({time:Date.now()-40*86400000})]));assert.equal(new Store(dir).records.length,0);
});
