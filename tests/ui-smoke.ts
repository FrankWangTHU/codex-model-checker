import {_electron as electron,expect} from '@playwright/test';
import {mkdtempSync,mkdirSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
async function main(){
const directory=mkdtempSync(join(tmpdir(),'cmc-ui-'));mkdirSync('test-results',{recursive:true});
const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((item):item is [string,string]=>typeof item[1]==='string')),CMC_LOG_ROOT:join(directory,'logs'),CMC_DATA_DIR:join(directory,'data'),CODEX_HOME:join(directory,'codex')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[resolve('.')],env});
try{
  const page=await app.firstWindow();await expect(page.getByText('Model Checker',{exact:true})).toBeVisible();await expect(page.getByText('Codex',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/mini-window.png'});
  await page.getByRole('button',{name:'设置',exact:true}).click();await expect(page.getByText('ChatGPT 浏览器扩展',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'生成配对码'}).click();await expect(page.locator('.pair-code')).toContainText(/\d{8}/);
  await page.screenshot({path:'test-results/settings.png'});
  await expect(page.getByText('Codex 只读检测',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'开启临时诊断',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'恢复普通启动',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'启用代理',exact:true})).toHaveCount(0);
  const rejected=await page.evaluate(()=>window.checker.command('proxy-on'));
  if(!('ok' in rejected)||rejected.ok)throw new Error('Unsafe legacy proxy enabled');
  if(existsSync(join(directory,'codex','config.toml')))throw new Error('Read-only mode modified Codex configuration');
  await page.getByRole('button',{name:'检测记录',exact:true}).click();await expect(page.getByText('等待第一条模型证据')).toBeVisible();
  await page.screenshot({path:'test-results/history.png'});
  await page.getByTitle('收起详情').click();await page.getByTitle('折叠窗口').click();await expect(page.getByText('正在观察模型证据')).toBeVisible();await page.getByText('正在观察模型证据').click();
  console.log('Electron mini window, settings, pairing, read-only mode and legacy proxy rejection, collapse and empty history passed.');
}finally{await app.close();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
