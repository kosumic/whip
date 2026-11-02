/** Offline, GPU-rendered cloud volume. No assets, network requests, or audio. */
export const VOICE_ORB_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}canvas{display:block;width:100%;height:100%;border-radius:50%;background:radial-gradient(ellipse at 75% 90%,#f8edff 0%,#d9b6fa 40%,#b369ef 75%)}
</style></head><body><canvas id="orb"></canvas><script>
const canvas=document.getElementById('orb');
const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false,preserveDrawingBuffer:false,depth:false,stencil:false});
let level=0,targetLevel=0,speaking=0,targetSpeaking=0,paused=false,frame=0,last=0,time=0;
window.setVoiceState=function(state){targetLevel=Math.min(1,Math.max(0,state.level*6));targetSpeaking=state.speaking?1:0;paused=state.reducedMotion;};
if(gl){
 const vertex='attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}';
 const fragment=\`precision highp float;
 uniform vec2 resolution;uniform float time;uniform float energy;uniform float speaking;
 float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
 float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
 float fbm(vec2 p){float n=0.,a=.53;for(int i=0;i<5;i++){n+=a*noise(p);p=mat2(.8,-.6,.6,.8)*p*2.03+vec2(4.3,7.1);a*=.49;}return n;}
 void main(){
   vec2 p=(gl_FragCoord.xy/resolution-.5)*2.;float r=length(p);
   float z=sqrt(max(0.,1.-dot(p,p)));
   vec2 q=p*(1.65+.28*z);float t=time*.16;
   vec2 flow=vec2(fbm(q+vec2(t*.55,-t*.32)),fbm(q+vec2(5.2-t*.3,1.7+t*.48)));
   float cloud=fbm(q*2.2+flow*2.8+vec2(t*.65,-t*.7));
   float detail=fbm(q*5.1+flow*2.1+vec2(-t*.8,t*.4));
   float horizon=-p.y+.26*p.x-.02+(cloud-.48)*(.85+energy*.35)+(detail-.5)*.22;
   float mist=smoothstep(-.22,.16,horizon);
   float plume=smoothstep(-.04,.12,horizon+(detail-.5)*.32);
   vec3 violet=mix(vec3(.65,.32,.92),vec3(.73,.44,.97),.6+.25*p.x-.1*p.y);
   vec3 pearl=mix(vec3(.82,.68,.96),vec3(.99,.96,1.),.58+.3*z+.15*p.y);
   vec3 color=mix(violet,pearl,mist*.65+plume*.35);
   float bloom=exp(-horizon*horizon*13.)*(.08+.12*detail+.05*speaking);
   color=mix(color,vec3(1.,.97,1.),bloom);
   color+=energy*.025*z;float alpha=1.-smoothstep(.985,1.,r);
   gl_FragColor=vec4(color,alpha);
 }\`;
 function shader(type,source){const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader;}
 try{
   const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);
   if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
   gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
   const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
   const uniforms={};for(const key of ['resolution','time','energy','speaking'])uniforms[key]=gl.getUniformLocation(program,key);
   function draw(now){
     const delta=Math.min(.05,(now-last)/1000||0);last=now;level+=(targetLevel-level)*.12;speaking+=(targetSpeaking-speaking)*.08;
     if(!paused)time+=delta*(.65+speaking*.6+level*.5);
     const size=Math.min(384,Math.round(canvas.clientWidth*Math.min(devicePixelRatio,1.5)));
     if(canvas.width!==size){canvas.width=canvas.height=size;gl.viewport(0,0,size,size);}
     gl.uniform2f(uniforms.resolution,size,size);gl.uniform1f(uniforms.time,time);gl.uniform1f(uniforms.energy,paused?0:level);gl.uniform1f(uniforms.speaking,speaking);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
     frame=requestAnimationFrame(draw);
   }
   document.addEventListener('visibilitychange',()=>{cancelAnimationFrame(frame);last=0;if(!document.hidden)frame=requestAnimationFrame(draw);});
   canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();cancelAnimationFrame(frame);});
   frame=requestAnimationFrame(draw);
 }catch(error){window.ReactNativeWebView?.postMessage(JSON.stringify({error:String(error)}));}
}
</script></body></html>`;
