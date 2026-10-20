// Render the unmodified Azure SVG into the desktop and PWA brand assets.
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),sharp=require(process.argv[2]||'sharp');
const root=resolve(import.meta.dirname,'..'),assets=join(root,'public/assets'),mobile=join(root,'public/mobile');
const svg=await readFile(join(root,'public/icon.svg')),sizes=[16,20,24,32,40,48,64,96,128,256],frames=[];
async function render(size){
  const png=await sharp(svg,{density:72*size/48}).resize(size,size).ensureAlpha().png().toBuffer();
  const meta=await sharp(png).metadata(),stats=await sharp(png).stats();
  if(meta.width!==size||meta.height!==size||!meta.hasAlpha||stats.channels.at(-1).min!==0)throw Error('Invalid brand icon frame');
  return png;
}
for(const size of sizes){const png=await render(size);frames.push(png);if(size===256)await writeFile(join(assets,'starport-desktop-azure-preview.png'),png);}
const header=Buffer.alloc(6);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
let offset=6+16*sizes.length;const entries=[];
for(let i=0;i<sizes.length;i++){
  const entry=Buffer.alloc(16),size=sizes[i];entry[0]=entry[1]=size===256?0:size;
  entry.writeUInt16LE(1,4);entry.writeUInt16LE(32,6);entry.writeUInt32LE(frames[i].length,8);entry.writeUInt32LE(offset,12);
  offset+=frames[i].length;entries.push(entry);
}
await writeFile(join(assets,'starport-desktop-azure.ico'),Buffer.concat([header,...entries,...frames]));
await writeFile(join(mobile,'icon.svg'),svg);
for(const size of [180,192,512])await writeFile(join(mobile,`icon-${size}.png`),await render(size));
console.log(JSON.stringify({source:'public/icon.svg',desktop:'public/assets/starport-desktop-azure.ico',desktopSizes:sizes,mobileSizes:[180,192,512]}));
