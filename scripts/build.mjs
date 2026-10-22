import {build} from 'esbuild';
import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
await mkdir('dist/ui',{recursive:true});await mkdir('dist/extension',{recursive:true});
await Promise.all([
  build({entryPoints:['src/main/main.ts'],bundle:true,platform:'node',format:'cjs',target:'node24',outfile:'dist/main.cjs',external:['electron'],sourcemap:true}),
  build({entryPoints:['src/main/preload.ts'],bundle:true,platform:'node',format:'cjs',target:'node24',outfile:'dist/preload.cjs',external:['electron']}),
  build({entryPoints:['src/ui/app.tsx'],bundle:true,platform:'browser',format:'iife',target:'chrome140',outfile:'dist/ui/ui.js',minify:true,define:{'process.env.NODE_ENV':'"production"'}}),
  ...['page','content','background','popup'].map(name=>build({entryPoints:[`src/extension/${name}.ts`],bundle:true,platform:'browser',format:'iife',target:'chrome111',outfile:`dist/extension/${name}.js`,minify:true})),
  copyFile('src/ui/index.html','dist/ui/index.html'),copyFile('src/extension/manifest.json','dist/extension/manifest.json'),copyFile('src/extension/popup.html','dist/extension/popup.html')
]);
// A code-generated PNG tray icon, with no remote assets or image dependency.
const size=256,raw=Buffer.alloc(size*(1+size*4));
for(let y=0;y<size;y++){const row=y*(1+size*4);for(let x=0;x<size;x++){const p=row+1+x*4,sx=x/8,sy=y/8;const inside=sx>=2&&sx<30&&sy>=2&&sy<30;const check=(sx>=7&&sx<=13&&Math.abs(sy-(sx+7))<2)||(sx>=12&&sx<=25&&Math.abs(sy-(-sx+32))<2);raw[p]=check?255:39;raw[p+1]=check?255:59;raw[p+2]=check?255:87;raw[p+3]=inside?255:0;}}
const crc=buffer=>{let c=0xffffffff;for(const v of buffer){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const name=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([len,name,data,sum]);};
const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
await writeFile('dist/icon.png',png);
const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);await writeFile('dist/icon.ico',Buffer.concat([ico,png]));
console.log('Built desktop app and browser extension.');
await mkdir('dist/diagnostics',{recursive:true});
for(const name of ['schedule-desktop-diagnostic.ps1','restart-desktop-diagnostic.ps1','start-desktop-diagnostic.ps1'])await writeFile(`dist/diagnostics/${name}`,'\uFEFF'+(await readFile(`scripts/${name}`,'utf8')).replace(/^\uFEFF/,''));
