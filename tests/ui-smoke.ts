import {_electron as electron,expect} from '@playwright/test';
import {mkdtempSync,mkdirSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
async function main(){
const directory=mkdtempSync(join(tmpdir(),'cmc-ui-'));mkdirSync('test-results',{recursive:true});
const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((item):item is [string,string]=>typeof item[1]==='string')),CMC_DATA_DIR:join(directory,'data'),CODEX_HOME:join(directory,'codex')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[resolve('.')],env});
try{
  const page=await app.firstWindow();await expect(page.getByText('Model Checker',{exact:true})).toBeVisible();await expect(page.getByText('Codex',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/mini-window.png'});
  await page.getByRole('button',{name:'设置',exact:true}).click();await expect(page.getByText('ChatGPT 浏览器扩展',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'生成配对码'}).click();await expect(page.locator('.pair-code')).toContainText(/\d{8}/);
  await page.screenshot({path:'test-results/settings.png'});
  await page.getByRole('button',{name:'启用代理',exact:true}).click();await expect(page.getByRole('button',{name:'恢复配置',exact:true})).toBeVisible();
  if(!readFileSync(join(directory,'codex','config.toml'),'utf8').includes('127.0.0.1:43822'))throw new Error('Proxy configuration was not installed');
  await page.getByRole('button',{name:'恢复配置',exact:true}).click();await expect(page.getByRole('button',{name:'启用代理',exact:true})).toBeVisible();
  if(existsSync(join(directory,'codex','config.toml')))throw new Error('Previously absent configuration was not restored');
  await page.getByRole('button',{name:'检测记录',exact:true}).click();await expect(page.getByText('等待第一条模型证据')).toBeVisible();
  await page.screenshot({path:'test-results/history.png'});
  await page.getByTitle('收起详情').click();await page.getByTitle('折叠窗口').click();await expect(page.getByText('正在观察模型证据')).toBeVisible();await page.getByText('正在观察模型证据').click();
  console.log('Electron mini window, settings, pairing, proxy enable/restore, collapse and empty history passed.');
}finally{await app.close();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
