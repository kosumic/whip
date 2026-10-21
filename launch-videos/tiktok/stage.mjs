import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

const WIDTH=1080, HEIGHT=1920, DURATION=30;
const CUT={herd:5.2,chat:10,composer:13,terminal:16,diff:18.5,return:23.5,final:25.2};
const clamp=value=>Math.max(0,Math.min(1,value));
const smooth=value=>{const p=clamp(value);return p*p*(3-2*p);};
const out=value=>1-Math.pow(1-clamp(value),3);
const mix=THREE.MathUtils.lerp;
const interpolate=(a,b,p)=>a.map((value,index)=>mix(value,b[index],p));
const clock={time:0};
let mediaRevision=0,lastRevision=-1,lastRenderTime=-1;
let renderAt=()=>{};
let resolveReady;
const ready=new Promise(resolve=>{resolveReady=resolve;});
window.__hf=window.__hf||{};
window.__hf.buildReady=window.__hf.buildReady||{};
window.__hf.buildReady['whip-3d-product']=ready;
window.addEventListener('hf-seek',event=>{
  clock.time=Number(event.detail?.time??event.detail)||0;
  renderAt(clock.time);
});

const renderer=new THREE.WebGLRenderer({canvas:document.getElementById('product-canvas'),antialias:true,alpha:false,preserveDrawingBuffer:true,powerPreference:'high-performance'});
renderer.setSize(WIDTH,HEIGHT,false);
renderer.setPixelRatio(1);
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=.94;
const scene=new THREE.Scene();
const LIGHT=new THREE.Color('#edf0f2'),DARK=new THREE.Color('#111419');
scene.background=LIGHT.clone();
const camera=new THREE.PerspectiveCamera(35,WIDTH/HEIGHT,.05,100);
camera.position.set(0,0,15);
const pmrem=new THREE.PMREMGenerator(renderer);
const environment=new THREE.Scene();
const room=new RoomEnvironment();
room.traverse(object=>{if(object.isLight)object.intensity*=.25;});
environment.add(room);
for(const [angle,intensity,width] of [[-35,3,2.3],[125,4,1.3]]){
  const strip=new THREE.Mesh(new THREE.PlaneGeometry(width,9),new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide}));
  strip.material.color.multiplyScalar(intensity);
  const a=THREE.MathUtils.degToRad(angle);
  strip.position.set(7*Math.sin(a),2,7*Math.cos(a));
  strip.lookAt(0,0,0);environment.add(strip);
}
const environmentTarget=pmrem.fromScene(environment,.04);
scene.environment=environmentTarget.texture;
scene.environmentIntensity=.65;
const key=new THREE.DirectionalLight(0xfffcf8,2.8);
key.position.set(-5,8,9);
const fill=new THREE.HemisphereLight(0xffffff,0x8e9caa,1.35);
const rim=new THREE.DirectionalLight(0xdbe8ff,2.1);
rim.position.set(6,1,-4);
scene.add(key,fill,rim);

const gltf=await new GLTFLoader().loadAsync('assets/models/iphone-17-pro.glb');
gltf.scene.updateMatrixWorld(true);
const bounds=new THREE.Box3().setFromObject(gltf.scene);
const center=bounds.getCenter(new THREE.Vector3());
const size=bounds.getSize(new THREE.Vector3());
const modelScale=5.8/Math.max(size.x,size.y,size.z);
const screenMesh=gltf.scene.getObjectByName('Object_33');
if(!screenMesh)throw new Error('Phone screen mesh Object_33 missing');
const screenBox=new THREE.Box3().setFromObject(screenMesh);
const screenCenter=screenBox.getCenter(new THREE.Vector3());
const screenSize=screenBox.getSize(new THREE.Vector3());
const DISPLAY={width:screenSize.x*modelScale*.982,height:screenSize.y*modelScale*.983,
  x:(screenCenter.x-center.x)*modelScale,y:(screenCenter.y-center.y)*modelScale,z:(screenCenter.z-center.z)*modelScale+.022};
gltf.scene.traverse(object=>{
  if(!object.isMesh||!object.material)return;
  object.material=object.material.clone();
  if(object.material.isMeshStandardMaterial){
    object.material.envMapIntensity=.8;
    object.material.roughness=Math.max(.22,Math.min(.65,object.material.roughness));
  }
});
const screenMask=document.createElement('canvas');
screenMask.width=600;screenMask.height=1304;
const maskContext=screenMask.getContext('2d');
maskContext.fillStyle='white';maskContext.beginPath();maskContext.roundRect(0,0,600,1304,76);maskContext.fill();
const maskTexture=new THREE.CanvasTexture(screenMask);
const phone=new THREE.Group(),normalizer=new THREE.Group();
gltf.scene.position.sub(center);normalizer.add(gltf.scene);normalizer.scale.setScalar(modelScale);phone.add(normalizer);
const display=new THREE.Mesh(new THREE.PlaneGeometry(DISPLAY.width,DISPLAY.height),new THREE.MeshBasicMaterial({alphaMap:maskTexture,alphaTest:.5,transparent:true,toneMapped:false,side:THREE.FrontSide,depthWrite:false}));
display.position.set(DISPLAY.x,DISPLAY.y,DISPLAY.z);display.renderOrder=20;phone.add(display);scene.add(phone);

// One complete video frame covers the phone display. No regions are cut out or duplicated.
const sourceIds=['screen-hosts','screen-herd','screen-chat','screen-composer','screen-terminal','screen-diff','screen-return'];
const screenTextures=new Map(sourceIds.map(id=>{
  const texture=new THREE.VideoTexture(document.getElementById(id));
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;
  return[id,texture];
}));
const frameTextures=new Map(sourceIds.map(id=>{
  const texture=new THREE.Texture();texture.colorSpace=THREE.SRGBColorSpace;
  texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;
  return[id,texture];
}));
const textureFor=id=>{
  const video=document.getElementById(id);
  const key=window.__hfMediaId?.(video)||id;
  const frame=document.getElementById(`__render_frame_${key}__`);
  if(!frame?.complete||frame.naturalWidth<10)return screenTextures.get(id);
  const texture=frameTextures.get(id);texture.image=frame;texture.needsUpdate=true;return texture;
};
let currentSource='screen-hosts';
const sourceAt=t=>t<CUT.herd?'screen-hosts':t<CUT.chat?'screen-herd':t<CUT.composer?'screen-chat':t<CUT.terminal?'screen-composer':t<CUT.diff?'screen-terminal':t<CUT.return?'screen-diff':'screen-return';
const pose=(position,rotation,scale)=>{phone.position.set(...position);phone.rotation.set(...rotation);phone.scale.setScalar(scale);};
const cameraPose=(position,target)=>{camera.position.set(...position);camera.lookAt(...target);};

// Fit the real display to the viewing frame, rather than fitting the entire
// handset. Camera travel reveals lower controls after the headline clears.
const FEATURE={width:.84,scale:.85,phoneY:-.65};
const halfFov=Math.tan(THREE.MathUtils.degToRad(camera.fov/2));
const featurePose=(top,angle)=>{
  const distance=DISPLAY.width*FEATURE.scale/(2*halfFov*camera.aspect*FEATURE.width);
  const screenTop=FEATURE.phoneY+(DISPLAY.y+DISPLAY.height/2)*FEATURE.scale;
  const y=screenTop-(1-2*top/HEIGHT)*distance*halfFov;
  return{position:[0,FEATURE.phoneY,0],rotation:[.015,angle,0],scale:FEATURE.scale,
    camera:[0,y,distance+DISPLAY.z*FEATURE.scale],target:[0,y,0]};
};
const widePose={position:[0,.18,0],rotation:[-.015,-.19,.015],scale:.77,camera:[.05,.1,14.8],target:[0,.1,0]};
const closingPose={position:[0,-.2,0],rotation:[-.015,-.18,0],scale:.73,camera:[0,0,14.8],target:[0,0,0]};
const shotPoses=[
  {time:0,position:[.25,-1.3,0],rotation:[.08,-.82,-.07],scale:.8,camera:[.7,.35,11.8],target:[0,.1,0]},
  {time:1.5,...widePose,ease:out},
  {time:2.7,...widePose},
  {time:3.4,...featurePose(420,-.06)},
  {time:CUT.herd,...featurePose(420,-.06)},
  {time:5.85,...featurePose(600,-.06)},
  {time:8.4,...featurePose(600,-.06)},
  {time:9.15,...featurePose(-80,-.025)},
  {time:CUT.chat,...featurePose(-80,-.025)},
  {time:10.65,...featurePose(600,.075)},
  {time:12.35,...featurePose(600,.075)},
  {time:CUT.composer,...featurePose(-200,.025)},
  {time:13.55,...featurePose(-550,.025)},
  {time:CUT.terminal,...featurePose(-550,.025)},
  {time:16.65,...featurePose(600,-.065)},
  {time:17.75,...featurePose(600,-.065)},
  {time:18.4,...featurePose(40,-.025)},
  {time:CUT.diff,...featurePose(40,-.025)},
  {time:19.15,...featurePose(600,.065)},
  {time:20.9,...featurePose(600,.065)},
  {time:21.65,...featurePose(-250,.02)},
  {time:CUT.return,...featurePose(-250,.02)},
  {time:CUT.final,...closingPose},
];
const applyShotPose=t=>{
  const endIndex=shotPoses.findIndex(shot=>shot.time>=t);
  const end=shotPoses[Math.max(0,endIndex)],start=shotPoses[Math.max(0,endIndex-1)];
  const p=end.time===start.time?1:(end.ease||smooth)((t-start.time)/(end.time-start.time));
  pose(interpolate(start.position,end.position,p),interpolate(start.rotation,end.rotation,p),mix(start.scale,end.scale,p));
  cameraPose(interpolate(start.camera,end.camera,p),interpolate(start.target,end.target,p));
};

renderAt=time=>{
  const t=THREE.MathUtils.clamp(time,0,DURATION);clock.time=t;
  if(window[Symbol.for('hyperframes.webglDrawGate')]?.skip)return;
  if(Math.abs(t-lastRenderTime)<1e-6&&mediaRevision===lastRevision)return;
  lastRenderTime=t;lastRevision=mediaRevision;
  const darken=smooth((t-CUT.final)/.6);
  scene.background.copy(LIGHT).lerp(DARK,darken);
  key.intensity=mix(2.8,3.4,darken);
  currentSource=sourceAt(t);
  const texture=textureFor(currentSource);
  if(display.material.map!==texture){display.material.map=texture;display.material.needsUpdate=true;}

  if(t<CUT.final){
    applyShotPose(t);
  }else{
    const p=out((t-CUT.final)/1),settle=smooth((t-CUT.final-1)/3.8);
    pose([mix(0,.9,p),mix(-.2,-.1,p),0],[-.015,-.18+settle*.04,0],mix(.73,.6,p));
    cameraPose([0,0,mix(14.8,13.6,p)],[0,0,0]);
  }
  screenTextures.get(currentSource).needsUpdate=true;
  renderer.render(scene,camera);
};

for(const id of sourceIds){
  const video=document.getElementById(id);
  const refresh=()=>{if(id===currentSource){mediaRevision+=1;renderAt(clock.time);}};
  video.addEventListener('seeked',refresh);video.addEventListener('loadeddata',refresh);
  if(video.requestVideoFrameCallback){const decoded=()=>{refresh();video.requestVideoFrameCallback(decoded);};video.requestVideoFrameCallback(decoded);}
}
document.addEventListener('load',event=>{
  if(event.target instanceof HTMLImageElement&&event.target.classList.contains('__render_frame__')){mediaRevision+=1;renderAt(clock.time);}
},true);
const tl=gsap.timeline({paused:true});
const reseek=window.__hfReseekGpu;
window.__hfReseekGpu=time=>{reseek?.(time);mediaRevision+=1;renderAt(time);};
tl.to(clock,{time:DURATION,duration:DURATION,ease:'none',onUpdate:()=>renderAt(clock.time)},0);
window.__timelines=window.__timelines||{};
window.__timelines['product-stage']=tl;
renderer.compile(scene,camera);
renderAt(window.__hfThreeTime||0);
resolveReady();
