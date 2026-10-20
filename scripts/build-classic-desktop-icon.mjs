// Convert the existing unmodified theme SVG into transparent Windows ICO frames.
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),sharp=require(process.argv[2]||'sharp');
const root=resolve(import.meta.dirname,'..'),assets=join(root,'public','assets');
const svg=await readFile(join(assets,'spaceport-icon.svg'));
const sizes=[16,20,24,32,40,48,64,96,128,256],frames=[];
for(const size of sizes){
  const png=await sharp(svg,{density:72*size/48}).resize(size,size).ensureAlpha().png().toBuffer();
  const meta=await sharp(png).metadata();if(meta.width!==size||meta.height!==size||!meta.hasAlpha)throw Error('Invalid icon frame');
  const stats=await sharp(png).stats(),alpha=stats.channels.at(-1);if(alpha.min!==0||alpha.max!==255)throw Error('Lost transparency');
  frames.push(png);
  if(size===256)await writeFile(join(assets,'starport-desktop-classic-preview.png'),png);
}
const header=Buffer.alloc(6);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
let offset=6+16*sizes.length;const entries=[];
for(let index=0;index<sizes.length;index++){
  const entry=Buffer.alloc(16),size=sizes[index];entry[0]=entry[1]=size===256?0:size;
  entry.writeUInt16LE(1,4);entry.writeUInt16LE(32,6);entry.writeUInt32LE(frames[index].length,8);entry.writeUInt32LE(offset,12);
  offset+=frames[index].length;entries.push(entry);
}
const target=join(assets,'starport-desktop-classic.ico');
await writeFile(target,Buffer.concat([header,...entries,...frames]));
console.log(JSON.stringify({icon:target,sizes,transparent:true,source:'public/assets/spaceport-icon.svg'}));
