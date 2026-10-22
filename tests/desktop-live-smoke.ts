// Opt-in local check against already enabled desktop diagnostics. No requests
// are created and no Codex processes or configuration are changed.
import {_electron as electron,expect} from '@playwright/test';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
async function main(){
  const directory=mkdtempSync(join(tmpdir(),'cmc-live-ui-'));const home=process.env.CODEX_HOME||join(homedir(),'.codex');const config=join(home,'config.toml');
  const hash=()=>existsSync(config)?createHash('sha256').update(readFileSync(config)).digest('hex'):null;const before=hash();
  const env={...process.env,CMC_DATA_DIR:directory} as Record<string,string>;delete env.ELECTRON_RUN_AS_NODE;delete env.CMC_LOG_ROOT;
  const app=await electron.launch({args:[resolve('.')],env});
  try{
    const page=await app.firstWindow();await expect(page.getByText('Model Checker',{exact:true})).toBeVisible();
    const thread=process.env.CODEX_THREAD_ID;if(!thread)throw new Error('Run this explicit test from the intended Codex conversation.');
    let rows:import('../src/core/types').RecordEntry[]=[];
    await expect.poll(async()=>{const snapshot=await page.evaluate(()=>window.checker.command('snapshot'));if(!('records'in snapshot))return 0;rows=snapshot.records.filter(r=>r.transport==='desktop'&&r.desktop?.threadId===thread&&r.desktop.association==='exact');return snapshot.status.desktop?.startsWith('桌面响应旁读中')?rows.length:0;},{timeout:60000}).toBeGreaterThan(0);
    await page.getByRole('button',{name:'记录 ↗',exact:true}).click();await page.locator(`[data-record-id="${rows[0].id}"]`).click();await expect(page.getByText('消息 ID 唯一匹配',{exact:true})).toBeVisible();await expect(page.getByText('证据详情',{exact:true})).toBeVisible();
    mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/desktop-live-evidence.png'});
    writeFileSync('test-results/desktop-live-metadata.json',JSON.stringify({checkedAt:new Date().toISOString(),threadId:thread,configurationUnchanged:before===hash(),records:rows},null,2));
    if(before!==hash())throw new Error('Codex configuration changed.');console.log(`Live desktop UI passed: ${rows.length} exact response associations; Codex configuration unchanged.`);
  }finally{await app.close();}
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
