import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {verdictText,type Snapshot,type RecordEntry} from '../core/types';
import './style.css';
declare global {interface Window {checker:{command:(command:string,value?:unknown)=>Promise<Snapshot|{ok:boolean;error?:string}>;subscribe:(fn:(snapshot:Snapshot)=>void)=>()=>void}}}
function App(){
  const [data,setData]=useState<Snapshot|null>(null),[expanded,setExpanded]=useState(false),[tab,setTab]=useState<'history'|'settings'>('history'),[selected,setSelected]=useState<RecordEntry|null>(null),[error,setError]=useState(''),[confirmClear,setConfirmClear]=useState(false);
  useEffect(()=>{const unsubscribe=window.checker.subscribe(setData);void window.checker.command('snapshot').then(value=>{if('records'in value)setData(value);});return unsubscribe;},[]);
  const command=async(name:string,value?:unknown)=>{setError('');const result=await window.checker.command(name,value);if('ok'in result&&!result.ok)setError(result.error??'操作失败');};
  const expand=(next:boolean)=>{setExpanded(next);void command('expand',next);};
  if(!data)return <div className="loading">正在连接本机检测服务…</div>;
  const latest=(source:'codex'|'chatgpt')=>data.records.find(r=>r.source===source);
  const row=(source:'codex'|'chatgpt',title:string)=>{const record=latest(source);const response=record?.candidates.filter(c=>c.kind==='route').map(c=>c.model).filter((v,i,a)=>a.indexOf(v)===i).join(' / ');
    return <button className={'source-row '+(record?.astraAlert?'alert-row':'')} onClick={()=>{setSelected(record??null);setTab('history');expand(true);}}><div className="source-title"><span className={'dot '+(source==='chatgpt'?data.status.chatgpt==='扩展已连接'?'online':'':record?'online':'')}/><b>{title}</b><span className={'badge '+(record?.verdict??'unknown')}>{record?verdictText[record.verdict]:'等待请求'}</span></div><div className="model-line"><span title={record?.requested??''}>{record?.requested??'—'}</span><span className="arrow">→</span><span title={response}>{response||'未取得响应路由'}</span></div></button>;
  };
  const collapsed=data.settings.collapsed&&!expanded;
  return <div className={'app '+(expanded?'expanded':'')}>
    <header><div className="brand"><span className="brand-icon">✓</span><strong>Model Checker</strong><small>本机</small></div><div className="window-controls"><button title="置顶" className={data.settings.alwaysOnTop?'active':''} onClick={()=>void command('top')}>⌖</button><button title={expanded?'收起详情':'折叠窗口'} onClick={()=>{if(expanded)expand(false);else void command('collapse');}}>−</button><button title="收回托盘" onClick={()=>void command('hide')}>×</button></div></header>
    {collapsed?<button className="collapsed" onClick={()=>void command('collapse')}><span className={'dot '+(data.records.some(r=>r.astraAlert)?'danger':'online')}/>{data.records.some(r=>r.astraAlert)?'检测到 Astra 标识不一致':'正在观察模型证据'}<span>展开 ↗</span></button>:<>
      <main><div className="summary-label">请求模型 <span>服务器报告的响应路由</span></div>{row('codex','Codex')}{row('chatgpt','ChatGPT')}</main>
      <footer><span>字段可核验 · 权重无法证明</span><button onClick={()=>{setTab('settings');expand(!expanded||tab!=='settings');}}>设置</button><button onClick={()=>{setTab('history');setSelected(null);expand(!expanded||tab!=='history');}}>记录 ↗</button></footer>
    </>}
    {expanded&&<section className="details"><nav><button className={tab==='history'?'chosen':''} onClick={()=>setTab('history')}>检测记录</button><button className={tab==='settings'?'chosen':''} onClick={()=>setTab('settings')}>连接与设置</button><span/>{tab==='history'&&<><button onClick={()=>void command('export')}>导出 JSON</button><button onClick={()=>setConfirmClear(!confirmClear)}>清空</button></>}</nav>
      {error&&<p className="error" role="alert">{error}</p>}
      {tab==='settings'?<div className="settings">
        <div className="setting-block"><div><h2>ChatGPT 浏览器扩展</h2><p>{data.status.chatgpt} · 首次加载扩展后输入配对码</p></div><button onClick={()=>void command('pair')}>生成配对码</button></div>
        {data.pairing.code&&<div className="pair-code">{data.pairing.code}<small>5 分钟有效 · 仅可使用一次</small></div>}
        <div className="setting-block"><div><h2>Codex 增强采集</h2><p>{data.status.proxy}</p><p>配置级代理不一定覆盖当前 Codex 的所有运行路径。<br/>启用或恢复后请重启 Codex；没有流量不代表模型一致。</p></div><button onClick={()=>void command(data.proxyEnabled?'proxy-off':'proxy-on')}>{data.proxyEnabled?'恢复配置':'启用代理'}</button></div>
        <p className="muted">{data.status.codex}</p>
        <div className="toggles"><label><input type="checkbox" checked={data.settings.login} onChange={()=>void command('login')}/>Windows 登录时后台启动</label><label><input type="checkbox" checked={data.settings.notifications} onChange={()=>void command('notifications')}/>Astra 不一致时发送静音通知</label></div>
        <p className="note">只保留模型元数据，最近 30 天 / 最多 10,000 条。窗口列出最近 500 条，导出包含全部保留记录。未保存对话正文或登录凭据。</p>
      </div>:<div className="history-layout"><div className="history-list">{confirmClear&&<div className="clear-confirm">删除全部本机检测记录？<button onClick={()=>{void command('clear');setSelected(null);setConfirmClear(false);}}>确认清空</button></div>}{data.records.length===0?<p className="empty">等待第一条模型证据<br/><small>请先连接扩展，或启用 Codex 采集。</small></p>:data.records.map(record=><button key={record.source+record.connection+record.id} className={'history-row '+(selected?.id===record.id?'selected':'')} onClick={()=>setSelected(record)}><div><b>{record.source==='codex'?'Codex':'ChatGPT'}</b><time>{new Date(record.time).toLocaleTimeString('zh-CN',{hour12:false})}</time><span className={'badge '+record.verdict}>{verdictText[record.verdict]}</span></div><p>{record.requested??'请求模型未知'} → {record.candidates.find(c=>c.kind==='route')?.model??'—'}</p></button>)}</div><aside>{selected?<><h2>证据详情</h2><p>{new Date(selected.time).toLocaleString('zh-CN',{hour12:false})}</p><dl><dt>请求模型</dt><dd>{selected.requested??'未知'}</dd><dt>请求证据</dt><dd>{selected.requestEvidence==='wire'?'网络请求字段':selected.requestEvidence==='session'?'会话记录（不是响应证明）':'缺失'}</dd><dt>采集渠道 / 状态</dt><dd>{selected.transport} / {selected.state}</dd></dl>{selected.candidates.map((c,i)=><div className="candidate" key={i}><small>{c.kind==='route'?'响应路由':'模型标签'} · {c.field}</small><code>{c.model}</code></div>)}<p className="note">缺少显式响应路由或对应网络请求时，结果为无法核验。不同标识不构成对后端实际权重的证明。</p></>:<p className="empty">选择记录查看字段来源</p>}</aside></div>}
    </section>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
