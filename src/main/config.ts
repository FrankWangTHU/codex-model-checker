import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parse } from 'smol-toml';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
interface Backup { original: string; existed: boolean; installedHash: string; upstream: string; token: string }
export class ProxyConfig {
  readonly backupFile: string;
  constructor(readonly configFile: string, directory: string) { this.backupFile=join(directory,'codex-proxy-backup.json'); }
  backup(): Backup | null { try { return JSON.parse(readFileSync(this.backupFile,'utf8')); } catch { return null; } }
  enable(port: number): Backup {
    if (existsSync(this.backupFile)) throw new Error('代理已配置；请先恢复后再重新启用。');
    const existed=existsSync(this.configFile), original=existed ? readFileSync(this.configFile,'utf8') : '';
    const parsed=parse(original);
    if (parsed.model_provider && parsed.model_provider !== 'openai') throw new Error('当前为自定义模型提供商，暂不自动修改；保留只读检测。');
    const upstream=typeof parsed.openai_base_url === 'string' ? parsed.openai_base_url : 'https://api.openai.com/v1';
    const url=new URL(upstream);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('上游地址必须为不含凭据、查询参数的 HTTPS URL。');
    const token=randomBytes(32).toString('hex');
    const tableStart=original.search(/^\s*\[/m),rootEnd=tableStart<0?original.length:tableStart;
    let modified=original.slice(0,rootEnd).replace(/^\s*openai_base_url\s*=.*(?:\r?\n|$)/m,'')+original.slice(rootEnd);
    modified=`# Model Checker managed endpoint; restore using the tray menu.\nopenai_base_url = "http://127.0.0.1:${port}/${token}/v1"\n`+modified;
    const verified=parse(modified);delete verified.openai_base_url;
    const expected={...parsed};delete expected.openai_base_url;
    if(JSON.stringify(verified)!==JSON.stringify(expected))throw new Error('配置结构不适合自动修改，请保留只读检测。');
    const backup={original,existed,installedHash:digest(modified),upstream,token};
    mkdirSync(dirname(this.configFile),{recursive:true});
    writeFileSync(this.backupFile,JSON.stringify(backup),{mode:0o600,flag:'wx'});
    try { writeFileSync(this.configFile,modified,{mode:0o600}); } catch (error) { unlinkSync(this.backupFile); throw error; }
    return backup;
  }
  restore(): void {
    const backup=this.backup(); if (!backup) return;
    const current=readFileSync(this.configFile,'utf8');
    if (digest(current) !== backup.installedHash) {
      // Preserve unrelated user edits; remove only the exact managed prefix.
      const lines=current.split(/\r?\n/); const endpoint=`openai_base_url = "http://127.0.0.1:43822/${backup.token}/v1"`;
      if (lines[0] !== '# Model Checker managed endpoint; restore using the tray menu.' || lines[1] !== endpoint) throw new Error('配置中的代理项已被修改，自动恢复已停止。备份保留在应用数据目录。');
      const originalParsed=parse(backup.original);
      const restored=(typeof originalParsed.openai_base_url === 'string' ? `openai_base_url = ${JSON.stringify(originalParsed.openai_base_url)}\n` : '')+lines.slice(2).join('\n');
      parse(restored); writeFileSync(this.configFile,restored,{mode:0o600});
    } else if (!backup.existed) unlinkSync(this.configFile);
    else writeFileSync(this.configFile,backup.original,{mode:0o600});
    unlinkSync(this.backupFile);
  }
}
