/** Offline, GPU-rendered rolling cloud boundary. No assets, network requests, or audio. */
export const VOICE_ORB_CANVAS_SCALE = 1.2;

export const VOICE_ORB_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}canvas{display:block;width:100%;height:100%;border-radius:50%}
</style></head><body><canvas id="orb"></canvas><script>
const canvas=document.getElementById('orb');
const CANVAS_SCALE=${VOICE_ORB_CANVAS_SCALE};
// The recordings swell from about 485px to 550px, then settle in roughly half a second.
const IDLE_RADIUS=.92,PULSE_RADIUS=.13,SEED_RADIUS=.025,ATTACK=32.,RELEASE=6.5;
const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false,preserveDrawingBuffer:false,depth:false,stencil:false});
let level=0,targetLevel=0,speaking=0,targetSpeaking=0,presence=0,targetPresence=0,paused=false,frame=0,last=0,time=0,initialized=false;
window.setVoiceState=function(state){
 targetLevel=Number.isFinite(state.level)?1.-Math.exp(-Math.max(0,state.level)*9.):0;
 targetSpeaking=state.speaking?1:0;targetPresence=state.ready?1:0;paused=state.reducedMotion;
 // Both presentations use the call's clock, so opening the transcript never restarts the clouds.
 time=Math.max(0,state.elapsed||0);
 if(!initialized){presence=time>1?targetPresence:0;level=targetLevel;speaking=targetSpeaking;initialized=true;}
 if(!gl)canvas.style.background=state.ready?'linear-gradient(#a45ff5 15%,#f5eaff 58%,#dec4fb 85%)':'#a45ff5';
};
if(gl){
 const vertex='attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}';
 const fragment=\`precision highp float;
 uniform vec2 resolution;uniform float time;uniform float energy;uniform float speaking;uniform float scale;
 float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
 vec2 gradient(vec2 cell){vec2 g=vec2(hash(cell),hash(cell+vec2(37.,17.)))*2.-1.;return g*inversesqrt(max(dot(g,g),.001));}
 // Smooth radial contributions avoid the straight creases of square value-noise cells.
 float noise(vec2 p){
   const float skew=.366025404,unskew=.211324865;
   vec2 cell=floor(p+(p.x+p.y)*skew);
   vec2 a=p-cell+(cell.x+cell.y)*unskew;
   vec2 corner=a.x>a.y?vec2(1.,0.):vec2(0.,1.);
   vec2 b=a-corner+unskew,c=a-1.+2.*unskew;
   vec3 weight=max(.5-vec3(dot(a,a),dot(b,b),dot(c,c)),0.);
   weight*=weight;weight*=weight;
   return .5+35.*dot(weight,vec3(dot(gradient(cell),a),dot(gradient(cell+corner),b),dot(gradient(cell+1.),c)));
 }
 float fbm(vec2 p){float n=0.,a=.53;for(int i=0;i<5;i++){n+=a*noise(p);p=mat2(.8,-.6,.6,.8)*p*2.03+vec2(4.3,7.1);a*=.49;}return n;}
 void main(){
   vec2 p=(gl_FragCoord.xy/resolution-.5)*2./scale;float r=length(p);
   if(r>1.){gl_FragColor=vec4(0.);return;}
   float z=sqrt(max(0.,1.-dot(p,p)));
   float t=time*.62;
   vec2 q=vec2(p.x*(1.15+.15*z),p.y*.85);
   vec2 flow=vec2(fbm(q*1.8+vec2(t*.35,-t*.22)),fbm(q*1.8+vec2(5.2-t*.26,1.7-t*.35)));
   vec2 folded=q*2.4+flow*(1.9+speaking*.2)+vec2(t*.4,-t*.65);
   float billow=fbm(folded);
   // Stretch the fine structure upward so the edge feathers into the purple sky.
   float wisps=fbm(folded*vec2(2.4,1.6)+vec2(billow*.9,-t*.7));
   float tilt=.26*sin(t*1.2+.8)+.07*sin(t*2.1);
   float boundary=-p.y+tilt*p.x-.03+.12*sin(t*1.1)+energy*.08
     +(billow-.5)*(.70+energy*.3);
   float horizon=boundary+(wisps-.5)*.12;
   float body=smoothstep(-.22,.28,boundary);
   float haze=exp(-pow((boundary-.03)*3.5,2.));
   float crest=exp(-pow((horizon-.055)*4.8,2.));
   float filaments=smoothstep(.40,.72,wisps)*exp(-pow((horizon+.08)*4.,2.));
   vec3 violet=mix(vec3(.64,.35,.96),vec3(.72,.46,.98),clamp(.4-.2*p.y+.15*z,0.,1.));
   vec3 lavender=vec3(.865,.765,.985);
   vec3 color=mix(violet,lavender,body);
   float light=clamp(haze*.64+crest*(.18+.10*billow)+filaments*.12,0.,.96);
   color=mix(color,vec3(.995,.969,1.),light);
   color+=(billow-.5)*.035*body+energy*.012*z;
   color=mix(vec3(.64,.35,.96),color,smoothstep(.04,.25,scale));
   float alpha=1.-smoothstep(1.-2./(resolution.x*scale),1.,r);
   gl_FragColor=vec4(color,alpha);
 }\`;
 function shader(type,source){const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader;}
 try{
   const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);
   if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
   gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
   const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
   const uniforms={};for(const key of ['resolution','time','energy','speaking','scale'])uniforms[key]=gl.getUniformLocation(program,key);
   function draw(now){
     const delta=Math.min(.05,(now-last)/1000||0);last=now;
     // Fast attack follows syllables; the slower release carries through short speech gaps.
     level+=(targetLevel-level)*(1.-Math.exp(-delta*(targetLevel>level?ATTACK:RELEASE)));
     speaking+=(targetSpeaking-speaking)*(1.-Math.exp(-delta*5.));
     presence+=(targetPresence-presence)*(1.-Math.exp(-delta*7.));
     if(!paused)time+=delta;
     const size=Math.min(384,Math.round(canvas.clientWidth*Math.min(devicePixelRatio,1.5)));
     if(canvas.width!==size){canvas.width=canvas.height=size;gl.viewport(0,0,size,size);}
     const breath=paused?0:Math.sin(time*1.7)*.004;
     const radius=paused?(targetPresence?IDLE_RADIUS:SEED_RADIUS):SEED_RADIUS+presence*(IDLE_RADIUS-SEED_RADIUS+level*PULSE_RADIUS+breath);
     gl.uniform2f(uniforms.resolution,size,size);gl.uniform1f(uniforms.time,paused?0:time);gl.uniform1f(uniforms.energy,paused?0:level);gl.uniform1f(uniforms.speaking,paused?0:speaking);gl.uniform1f(uniforms.scale,radius/CANVAS_SCALE);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
     frame=requestAnimationFrame(draw);
   }
   document.addEventListener('visibilitychange',()=>{cancelAnimationFrame(frame);last=0;if(!document.hidden)frame=requestAnimationFrame(draw);});
   canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();cancelAnimationFrame(frame);});
   frame=requestAnimationFrame(draw);
 }catch(error){window.ReactNativeWebView?.postMessage(JSON.stringify({error:String(error)}));}
}
</script></body></html>`;
