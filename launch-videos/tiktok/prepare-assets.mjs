import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const project=path.dirname(fileURLToPath(import.meta.url));
const launch=path.dirname(project);
const source=path.join(launch,'source-assets');
const assets=path.join(project,'assets');
const recordings=path.join(source,'ios/tiktok');
const ledger=[];
const record=(from,relative,provenance,extra={})=>{
  const output=path.join(assets,relative);
  ledger.push({path:`assets/${relative}`,source:path.relative(project,from),provenance,
    sha256:createHash('sha256').update(readFileSync(output)).digest('hex'),...extra});
};
const stage=(from,relative,provenance)=>{
  const output=path.join(assets,relative);mkdirSync(path.dirname(output),{recursive:true});
  copyFileSync(from,output);record(from,relative,provenance);
};
const ffmpeg=(args)=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{stdio:'inherit'});
const conform=(name,relative,duration)=>{
  const from=path.join(recordings,`${name}.mp4`),output=path.join(assets,relative);
  mkdirSync(path.dirname(output),{recursive:true});
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-of','json',from],{encoding:'utf8'}));
  ffmpeg(['-i',from,'-vf',`setpts=${duration/Number(probe.format.duration)}*(PTS-STARTPTS),fps=30,tpad=stop_mode=clone:stop_duration=0.1,trim=duration=${duration},setpts=PTS-STARTPTS`,
    '-an','-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p','-g','10','-movflags','+faststart',output]);
  record(from,relative,'Frozen real Whip iPhone simulator recording; source-assets/ios/tiktok/feature-sources.json',{duration});
};

stage(path.join(project,'node_modules/gsap/dist/gsap.min.js'),'vendor/gsap.min.js','GSAP 3.14.2; pinned dependency');
const three=path.join(project,'node_modules/three');
for(const name of ['three.module.js','three.core.js'])stage(path.join(three,`build/${name}`),`vendor/three/${name}`,'Three.js 0.181.2; MIT');
for(const name of ['loaders/GLTFLoader.js','environments/RoomEnvironment.js','utils/BufferGeometryUtils.js']){
  stage(path.join(three,`examples/jsm/${name}`),`vendor/three/addons/${name}`,'Three.js 0.181.2; MIT');
}
stage(path.join(three,'LICENSE'),'vendor/three/LICENSE','Three.js MIT license');
for(const name of ['Regular','Medium','Bold'])stage(path.join(launch,`../assets/gui-fonts/Inter-${name}.ttf`),`fonts/Inter-${name}.ttf`,'Whip app typography; Inter, SIL Open Font License');
stage(path.join(launch,'../assets/gui-fonts/OFL.txt'),'fonts/Inter-OFL.txt','Inter SIL Open Font License');
stage(path.join(source,'models/iphone-17-pro/iphone-17-pro.glb'),'models/iphone-17-pro.glb','Ibrahim.Bhl, CC BY 4.0; source-assets/models/iphone-17-pro/license.txt');
for(const name of ['apple','google-play'])stage(path.join(source,`brand/${name}.svg`),`${name}.svg`,'Existing official store mark');
stage(path.join(launch,'../assets/icon.png'),'icon.png','Original Whip illustrated mark');
stage(path.join(launch,'../site/whip-install-qr.png'),'whip-install-qr.png','Existing Whip download QR, also used by the landscape launch video; https://kosumic.github.io/whip/');

conform('hosts','video/hosts.mp4',5.2);
stage(path.join(recordings,'herd.mp4'),'video/herd-natural.mp4','Fresh mini simulator capture; source-assets/ios/tiktok/README.md');
conform('chat','video/remote-chat-v2.mp4',3);
conform('composer-typing','video/composer-v1.mp4',3);
conform('terminal','video/terminal-v3.mp4',2.5);
conform('git-diff','video/diff-v2.mp4',5);

const music=path.join(source,'music/mixkit-tech-house-vibes-130.mp3');
mkdirSync(path.join(assets,'audio'),{recursive:true});
ffmpeg(['-i',music,'-af','atrim=start=0:end=30,asetpts=PTS-STARTPTS,loudnorm=I=-15:TP=-1.5:LRA=7,afade=t=in:d=0.04,afade=t=out:st=29:d=1',
  '-ar','48000','-ac','2',path.join(assets,'audio/music-v2.wav')]);
record(music,'audio/music-v2.wav','Tech House vibes by Alejandro Magaña (A. M.), Mixkit Stock Music Free License; source-assets/music/TIKTOK-MUSIC-LICENSE.md',{duration:30});
mkdirSync(path.join(project,'.media'),{recursive:true});
writeFileSync(path.join(project,'.media/assets.json'),`${JSON.stringify(ledger,null,2)}\n`);
console.log(`Prepared ${ledger.length} local assets for Whip 3D.`);
