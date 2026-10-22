import archiver from 'archiver';
import {createWriteStream,createReadStream} from 'node:fs';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
await mkdir('release',{recursive:true});
const archive=archiver('zip',{zlib:{level:9}}),target=createWriteStream('release/model-checker-extension-0.1.0.zip');
const completed=new Promise((resolve,reject)=>{target.on('close',resolve);target.on('error',reject);archive.on('error',reject);});archive.pipe(target);archive.directory('dist/extension',false);await archive.finalize();await completed;
const names=(await readdir('release')).filter(name=>/\.(zip|exe)$/.test(name)).sort();
const checks=[];for(const name of names){const hash=createHash('sha256');for await(const chunk of createReadStream(join('release',name)))hash.update(chunk);checks.push(`${hash.digest('hex')}  ${name}`);}
await writeFile('release/SHA256SUMS.txt',checks.join('\n')+'\n');console.log(checks.join('\n'));
