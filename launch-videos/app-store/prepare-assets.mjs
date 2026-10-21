import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import path from 'node:path';

const root=path.dirname(fileURLToPath(import.meta.url));
const source=path.resolve(root,'../source-assets');
const assets=path.join(root,'assets');
const scenes=JSON.parse(readFileSync(path.join(root,'scenes.json'),'utf8'));
const ledger=[];
const record=(input,output,extra={})=>ledger.push({path:path.relative(root,output),source:path.relative(root,input),sha256:createHash('sha256').update(readFileSync(output)).digest('hex'),...extra});
const stage=(input,relative)=>{const output=path.join(assets,relative);mkdirSync(path.dirname(output),{recursive:true});copyFileSync(input,output);record(input,output);};
const ffmpeg=args=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{stdio:'inherit'});

stage(path.join(root,'node_modules/gsap/dist/gsap.min.js'),'vendor/gsap.min.js');
stage(path.resolve(root,'../../assets/gui-fonts/Inter-Medium.ttf'),'fonts/Inter-Medium.ttf');
stage(path.resolve(root,'../../assets/gui-fonts/OFL.txt'),'fonts/Inter-OFL.txt');
for(const scene of scenes){
  const input=path.join(source,'ios/tiktok',scene.source);
  const output=path.join(assets,'video',`${scene.id}.mp4`);
  mkdirSync(path.dirname(output),{recursive:true});
  const duration=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',input],{encoding:'utf8'}).trim());
  const holdAt=scene.holdAt;
  const rate=scene.trim||holdAt?1:scene.duration/duration;
  const sourceRange=holdAt?`trim=end=${holdAt},`:'';
  const pad=holdAt?scene.duration-holdAt:0.1;
  const filter=`${sourceRange}setpts=${rate}*(PTS-STARTPTS),fps=30,tpad=stop_mode=clone:stop_duration=${pad},trim=duration=${scene.duration},scale=886:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=886:1920,setsar=1`;
  ffmpeg(['-i',input,'-vf',filter,'-an','-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p','-g','10','-movflags','+faststart',output]);
  record(input,output,{duration:scene.duration,sourceDuration:duration,...(holdAt?{holdAt}:{}),mode:holdAt?'natural-speed trim and final-frame hold':scene.trim?'natural-speed trim':'duration conform'});
}
const music=path.join(source,'music/mixkit-tech-house-vibes-130.mp3');
const soundtrack=path.join(assets,'audio/music.wav');
mkdirSync(path.dirname(soundtrack),{recursive:true});
ffmpeg(['-i',music,'-af','atrim=end=30,asetpts=PTS-STARTPTS,loudnorm=I=-15:TP=-1.5:LRA=7,afade=t=in:d=0.08,afade=t=out:st=29:d=1','-ar','48000','-ac','2',soundtrack]);
record(music,soundtrack,{duration:30,license:'Mixkit Stock Music Free License; ../source-assets/music/TIKTOK-MUSIC-LICENSE.md'});
mkdirSync(path.join(root,'.media'),{recursive:true});
writeFileSync(path.join(root,'.media/assets.json'),`${JSON.stringify(ledger,null,2)}\n`);
console.log(`Prepared ${scenes.length} real-footage scenes and licensed music.`);
