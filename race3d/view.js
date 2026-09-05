import {batchStatic} from './batching.js?v=3';
import {ClientPrediction,VisualCorrection,STEP} from './prediction.js?v=4';
import {SnapshotBuffer} from './snapshots.js?v=4';
import * as THREE from './three.module.js';
import {Events,countryFor} from './events.js?v=5';
import {LocationView} from './locations.js?v=5';
import {track,random,createCars,step,resetCar,at,clamp} from './engine.js?v=3';
const $=id=>document.getElementById(id),canvas=$('game');
let session=null,localId=0,authority=false,canDrive=false,roster=[],remoteInputs={},receivedAt={},seq=0,lastSend=0,done=false,initialized=false,stalled=false,inputSeq=0,inputAck={},pendingSnapshot=null,lastAppliedSeq=-1,processedSnapshots=0,quality=0,lowSeconds=0,lastBoardHTML='';
const prediction=new ClientPrediction(),visualError=new VisualCorrection(),snapshots=new SnapshotBuffer(),frameTimes=[];
let correctionMax=0,correctionLast=0;
const post=m=>parent.postMessage({dpRace:1,id:session,...m},location.origin);
let renderer;
try{renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});}catch(e){$('error').hidden=false;$('error').textContent='Не удалось включить 3D. Попробуй браузер с аппаратным ускорением.';throw e;}
renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.setClearColor('#151823');renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;
const scene=new THREE.Scene();scene.fog=new THREE.Fog('#151823',160,280);const camera=new THREE.PerspectiveCamera(48,1,.1,400);
scene.add(new THREE.HemisphereLight(0xcde5ff,0x534063,2.5));const sun=new THREE.DirectionalLight(0xfff3dc,3);sun.position.set(-40,70,30);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-85,right:85,top:75,bottom:-75,near:1,far:180});sun.shadow.bias=-.0004;scene.add(sun);
const groundMat=new THREE.MeshStandardMaterial({color:'#274e4b',roughness:.9});
const terrain=new THREE.Mesh(new THREE.CylinderGeometry(94,87,5,96),groundMat);terrain.position.y=-2.8;terrain.receiveShadow=true;scene.add(terrain);
const base=new THREE.Mesh(new THREE.CylinderGeometry(87,84,4,96),new THREE.MeshStandardMaterial({color:'#202331',roughness:.65}));base.position.y=-7;scene.add(base);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(1000,1000),new THREE.MeshStandardMaterial({color:'#151823',roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-9.2;floor.receiveShadow=true;scene.add(floor);
let environment=new THREE.Group(),carGroup=new THREE.Group();scene.add(environment,carGroup);let seed='PIROG-'+Math.floor(Math.random()*99999),locationView,eventWorld,country,circuit,cars=[],meshes=[],mode='ready',elapsed=0,countdown=3,paused=false,overview=false,acc=0,previous=0,fpsFrames=0,fpsTime=0,lastUI=0,lastHit=0;const keys=new Set(),particles=[];
const materials=new Map();function material(color){if(!materials.has(color))materials.set(color,new THREE.MeshStandardMaterial({color,roughness:.48}));return materials.get(color);}
function box(w,h,d,color,x=0,y=0,z=0,parent=environment){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material(color));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
function disposeGroup(g){g.traverse(o=>{if(o.geometry)o.geometry.dispose();});g.clear();}
function ribbon(offsetA,offsetB,color,y){const vertices=[],indices=[];for(let i=0;i<=circuit.n;i++){const p=circuit.points[i%circuit.n];for(const off of [offsetA,offsetB])vertices.push(p.x+p.nx*off,y,p.z+p.nz*off);if(i<circuit.n){const a=i*2;indices.push(a,a+2,a+1,a+1,a+2,a+3);}}const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geo.setIndex(indices);geo.computeVertexNormals();const mat=material(color);mat.side=THREE.DoubleSide;const mesh=new THREE.Mesh(geo,mat);mesh.receiveShadow=true;environment.add(mesh);}
function build(){locationView?.dispose();disposeGroup(environment);disposeGroup(carGroup);for(const p of particles){scene.remove(p.mesh);p.mesh.geometry.dispose();}particles.length=0;
circuit=track(seed);country=countryFor(seed);groundMat.color.set(country.ground);scene.fog.color.set(country.sky);renderer.setClearColor(country.sky);sun.intensity=country.id==='sg'?1.5:country.id==='ua'?1.65:country.id==='ru'?2:3;locationView=new LocationView(scene,circuit,country);eventWorld=new Events(circuit,country,(type,c,e)=>{locationView.emit(type,c,e);if(type==='blast'){c.impact=.4;if(c.id===localId){shake=1.25;thud(22);}}});ribbon(-8,8,country.ground,-.23);ribbon(-5.5,5.5,country.road,.02);ribbon(-5.6,-5.4,'#ddd8ed',.035);ribbon(5.4,5.6,'#ddd8ed',.035);
for(let i=0;i<circuit.n;i+=2){const p=circuit.points[i],q=circuit.points[(i+2)%circuit.n];for(const side of [-1,1]){const off=side*6.1,m=box(1.05,.45,Math.hypot(q.x-p.x,q.z-p.z)+.15,country.curbs[i%4?0:1],p.x+p.nx*off,.24,p.z+p.nz*off);m.rotation.y=Math.PI/2-p.heading;}}
// Outer bump rails share the collision boundary in the simulation.
for(let i=0;i<circuit.n;i+=4){const p=circuit.points[i];for(const side of [-1,1]){const rail=box(.7,.7,p.len*4+.1,side===1?'#3c7671':'#4d526c',p.x+p.nx*side*9,.4,p.z+p.nz*side*9);rail.rotation.y=Math.PI/2-p.heading;}}
for(let i=0;i<12;i++){const p=at(circuit,i*circuit.length/12+12);const shape=new THREE.Shape();shape.moveTo(-.6,-.7);shape.lineTo(.6,-.7);shape.lineTo(0,.6);shape.closePath();const arrow=new THREE.Mesh(new THREE.ShapeGeometry(shape),material('#d9dbf0'));arrow.rotation.x=-Math.PI/2;arrow.rotation.z=-p.heading-Math.PI/2;arrow.position.set(p.x,.045,p.z);environment.add(arrow);}
const start=at(circuit,5);for(let i=0;i<10;i++)for(let j=0;j<2;j++){const m=box(1,.035,.7,(i+j)%2?'#ede9ff':'#202232',0,0,0);m.position.set(start.x+start.nx*(i-4.5)+Math.cos(start.heading)*j*.7,.065,start.z+start.nz*(i-4.5)+Math.sin(start.heading)*j*.7);m.rotation.y=Math.PI/2-start.heading;}
const rng=random(seed+'trees');for(let i=0;i<85;i++){const a=rng()*Math.PI*2,r=15+rng()*68,x=Math.cos(a)*r,z=Math.sin(a)*r;let near=Infinity;for(const p of circuit.points)near=Math.min(near,Math.hypot(x-p.x,z-p.z));if(near<12)continue;const h=1.7+rng()*3;box(.45,h*.65,.45,'#795450',x,h*.3,z);const tree=new THREE.Mesh(new THREE.IcosahedronGeometry(h*.65,0),material(country.trees[Math.floor(rng()*country.trees.length)]));tree.position.set(x,h,z);tree.castShadow=true;environment.add(tree);}
// Chunky start posts, leaving the driving surface clear.
for(const side of [-1,1])box(.7,3,.7,'#f4cc4e',start.x+start.nx*side*7,1.5,start.z+start.nz*side*7);
const roadBatch=batchStatic(environment);cars=createCars(circuit,roster[0].color,$('calm').checked,$('aggressive').checked,roster.slice(1).map(p=>p.color));meshes=cars.map(makeCar);window.__racePerf.batches={road:roadBatch,location:locationView.batchStats};elapsed=0;mode='ready';paused=false;acc=0;$('pause').textContent='Ⅱ';$('startPanel').hidden=false;$('start').textContent='На старт →';$('banner').textContent='';$('effect').textContent='';$('setupHint').textContent='Три круга · боты включаются отдельно';updateUI();updateCamera(1);locationView.update(eventWorld,0,0,camera);}
// Bevelled toy bodywork, with a low glass canopy instead of stacked boxes.
function rounded(w,h,d,color,x,y,z,parent,r=.18){
 const shape=new THREE.Shape(),hw=w/2,hd=d/2;r=Math.min(r,w/3,d/3);
 shape.moveTo(-hw+r,-hd);shape.lineTo(hw-r,-hd);shape.quadraticCurveTo(hw,-hd,hw,-hd+r);shape.lineTo(hw,hd-r);shape.quadraticCurveTo(hw,hd,hw-r,hd);shape.lineTo(-hw+r,hd);shape.quadraticCurveTo(-hw,hd,-hw,hd-r);shape.lineTo(-hw,-hd+r);shape.quadraticCurveTo(-hw,-hd,-hw+r,-hd);
 const geo=new THREE.ExtrudeGeometry(shape,{depth:h,bevelEnabled:true,bevelSegments:3,steps:1,bevelSize:.09,bevelThickness:.09,curveSegments:5});geo.rotateX(-Math.PI/2);geo.translate(0,-h/2,0);
 const m=new THREE.Mesh(geo,material(color));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;
}
function makeCar(c){const g=new THREE.Group();carGroup.add(g);
 rounded(1.72,.36,2.8,c.color,0,.63,0,g,.4);
 rounded(1.58,.14,2.52,c.color,0,.85,.03,g,.48);
 // A curved, smoked-glass canopy with a coloured roof spine.
 const canopy=new THREE.Mesh(new THREE.SphereGeometry(1,20,12),material('#252d43'));canopy.scale.set(.65,.46,.81);canopy.position.set(0,.93,-.15);canopy.castShadow=true;g.add(canopy);
 rounded(.83,.09,.87,c.color,0,1.29,-.22,g,.25);
 rounded(1.6,.13,.26,'#252637',0,.43,1.4,g,.1);rounded(1.6,.13,.26,'#252637',0,.43,-1.4,g,.1);
 for(const x of [-.56,.56]){rounded(.32,.09,.22,'#fff2b0',x,.82,1.18,g,.08);rounded(.3,.07,.13,'#ff5679',x,.72,-1.36,g,.06);}
 for(const x of [-.86,.86])for(const z of [-.87,.87]){const w=new THREE.Mesh(new THREE.CylinderGeometry(.4,.4,.38,20),material('#171824'));w.rotation.z=Math.PI/2;w.position.set(x,.41,z);w.castShadow=true;g.add(w);const hub=new THREE.Mesh(new THREE.CylinderGeometry(.21,.21,.39,12),material('#b7bdd0'));hub.rotation.z=Math.PI/2;hub.position.copy(w.position);g.add(hub);}
 if(c.kind==='aggressive'){for(const x of [-.58,.58])rounded(.1,.27,.13,'#303043',x,.93,-1.12,g,.03);rounded(1.85,.1,.35,c.color,0,1.12,-1.15,g,.12);}
 if(c.id===localId){const ring=new THREE.Mesh(new THREE.RingGeometry(1.8,1.94,40),new THREE.MeshBasicMaterial({color:c.color,side:THREE.DoubleSide,transparent:true,opacity:.8}));ring.rotation.x=-Math.PI/2;ring.position.y=.06;g.add(ring);}
 const blob=new THREE.Mesh(new THREE.CircleGeometry(1.25,16),new THREE.MeshBasicMaterial({color:'#080a12',transparent:true,opacity:.28,depthWrite:false}));blob.rotation.x=-Math.PI/2;blob.scale.set(1,1.5,1);blob.position.y=.055;blob.visible=quality>0;g.userData.shadowBlob=blob;g.add(blob);batchStatic(g);g.position.set(c.x,0,c.z);g.rotation.y=Math.PI/2-c.heading;return g;
}
let shake=0,thudAudio;
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
function thud(strength){if(!thudAudio)return;const t=thudAudio.currentTime,o=thudAudio.createOscillator(),gain=thudAudio.createGain();o.frequency.setValueAtTime(100,t);o.frequency.exponentialRampToValueAtTime(35,t+.12);gain.gain.setValueAtTime(Math.min(.15,strength*.008),t);gain.gain.exponentialRampToValueAtTime(.001,t+.14);o.connect(gain);gain.connect(thudAudio.destination);o.start(t);o.stop(t+.15);}
function hit(a,b,strength){if(elapsed-lastHit<.12)return;lastHit=elapsed;a.impact=.25;if(b)b.impact=.25;if(a.id===localId||b?.id===localId){shake=Math.min(1.1,.25+strength*.045);thud(strength);$('impact').style.boxShadow='inset 0 0 65px '+$('color').value+'50';setTimeout(()=>$('impact').style.boxShadow='',120);}for(let i=0;i<5;i++){if(particles.length>35)break;const m=new THREE.Mesh(new THREE.BoxGeometry(.17,.17,.17),material('#ffdf76'));m.position.set(a.x,.7,a.z);scene.add(m);particles.push({mesh:m,vx:(Math.random()-.5)*9,vz:(Math.random()-.5)*9,vy:3+Math.random()*4,life:.5});}}
function controls(){const typing=['INPUT','TEXTAREA'].includes(document.activeElement?.tagName);if(typing)return{gas:0,brake:0,steer:0,drift:false};return{gas:keys.has('KeyW')||keys.has('ArrowUp')?1:0,brake:keys.has('KeyS')||keys.has('ArrowDown')?1:0,steer:(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0),drift:keys.has('Space'),boost:keys.has('ShiftLeft')||keys.has('ShiftRight')};}
const cameraAim=new THREE.Vector3();
function updateCamera(dt){if(!cars.length)return;const c=visualError.pose(cars[localId]),f=new THREE.Vector3(Math.cos(c.heading),0,Math.sin(c.heading));const target=overview?new THREE.Vector3(0,135,83):new THREE.Vector3(c.x-f.x*25,36,c.z-f.z*25);camera.position.lerp(target,1-Math.exp(-dt*4));const look=overview?new THREE.Vector3(0,0,0):new THREE.Vector3(c.x+f.x*8,0,c.z+f.z*8);shake*=Math.exp(-dt*12);if(!reducedMotion&&shake>.005){const pulse=performance.now()*.095;camera.position.x+=Math.sin(pulse)*shake;camera.position.z+=Math.cos(pulse*1.3)*shake;camera.position.y+=Math.sin(pulse*.7)*shake*.3;}cameraAim.lerp(look,1-Math.exp(-dt*18));camera.lookAt(cameraAim);}
function updateUI(){const sorted=[...cars].sort((a,b)=>(a.finished&&b.finished?a.finishTime-b.finishTime:b.progress-a.progress));const boardHTML=sorted.map((c,i)=>`<li class="${c.id===localId?'me':''}"><b>${i+1}</b><i class="swatch" style="background:${c.color}"></i>${c.kind==='player'?'':c.name}<small>${c.finished?'Финиш':c.attacking?'↯':Math.max(1,Math.min(3,c.lap+1))+'/3'}</small></li>`).join('');if(boardHTML!==lastBoardHTML){$('positions').innerHTML=boardHTML;lastBoardHTML=boardHTML;}const c=cars[localId];$('speed').textContent=Math.round(Math.hypot(c.vx,c.vz)*3.6);$('lap').textContent=c.finished?'ФИНИШ':'КРУГ '+Math.min(3,c.lap+1)+' / 3';const effect=eventWorld.status(c);$('effect').textContent=effect?effect[0]+(effect[1]?' · '+effect[1]+' с':''):'';}
function tick(ms){requestAnimationFrame(tick);const frameStart=performance.now(),rawDt=(ms-previous)/1000||.016,dt=Math.min(rawDt,.08);previous=ms;frameTimes.push(rawDt*1000);if(frameTimes.length>120)frameTimes.shift();fpsFrames++;fpsTime+=rawDt;if(fpsTime>1){const fps=Math.round(fpsFrames/fpsTime);$('fps').textContent=fps+' FPS';window.__racePerf.fps=fps;const sorted=[...frameTimes].sort((a,b)=>a-b);Object.assign(window.__racePerf,{frameP95Ms:+(sorted[Math.floor(sorted.length*.95)]||0).toFixed(1),frameMaxMs:+(sorted.at(-1)||0).toFixed(1),...snapshots.stats(performance.now()),correctionM:+correctionLast.toFixed(3),correctionMaxM:+correctionMax.toFixed(3),visualOffsetM:+Math.hypot(visualError.x,visualError.z).toFixed(3),predictionAheadMs:Math.round((prediction.tick-prediction.serverTick)*STEP*1000)});lowSeconds=!document.hidden&&initialized&&fps<30?lowSeconds+fpsTime:0;if(lowSeconds>3&&quality<2){setQuality(quality+1);lowSeconds=0;}fpsFrames=0;fpsTime=0;}
if(!initialized)return;if(pendingSnapshot){const latest=pendingSnapshot;pendingSnapshot=null;applySnapshot(latest);}if(stalled){renderer.render(scene,camera);return;}if(!paused){if(mode==='countdown'&&authority){countdown-=dt;$('banner').textContent=countdown>0?Math.ceil(countdown):'ГАЗ!';if(countdown<-.5){mode='racing';$('banner').textContent='';}}
if(mode==='racing'&&authority){acc+=dt;while(acc>=1/120){elapsed+=1/120;eventWorld.update(1/120,elapsed,cars);step(circuit,cars,{players:inputMap()},1/120,elapsed,hit);eventWorld.constrain(cars);acc-=1/120;}if(cars.filter(c=>c.kind==='player').every(c=>c.finished)||elapsed>=180){mode='finished';done=true;}}
if(!authority&&canDrive&&mode==='racing'){acc+=dt;while(acc>=STEP){prediction.advance(circuit,cars[localId],controls(),constrainPrediction);acc-=STEP;}}
if(!authority)visualError.decay(dt,cars[localId]);
const renderState=!authority?snapshots.advance(dt):null;
if(renderState){for(const c of cars){if(c.id===localId&&canDrive&&(mode==='racing'||mode==='finished'))continue;const target=renderState.cars[c.id];if(target){c.x=target.x;c.z=target.z;c.heading=target.heading;}}}
if(mode==='finished'){const sorted=[...cars].sort((a,b)=>a.finished&&b.finished?a.finishTime-b.finishTime:b.progress-a.progress),place=sorted.findIndex(c=>c.id===localId)+1;$('banner').textContent=cars[localId].finished?'ФИНИШ · '+place+' МЕСТО':'ВРЕМЯ ВЫШЛО';}

for(const [i,c]of cars.entries()){const g=meshes[i];c.impact=Math.max(0,(c.impact||0)-dt);const bump=reducedMotion?0:c.impact;g.position.set(c.x+(i===localId?visualError.x:0),Math.sin(bump*35)*bump*.4,c.z+(i===localId?visualError.z:0));g.rotation.set(Math.sin(bump*32)*bump*.3,Math.PI/2-c.heading-(i===localId?visualError.heading:0),Math.sin(bump*45)*bump*.5);}
for(let i=particles.length-1;i>=0;i--){const p=particles[i];p.life-=dt;p.vy-=15*dt;p.mesh.position.x+=p.vx*dt;p.mesh.position.z+=p.vz*dt;p.mesh.position.y+=p.vy*dt;if(p.life<0){scene.remove(p.mesh);p.mesh.geometry.dispose();particles.splice(i,1);}}
updateCamera(dt);locationView.update(renderState?{...eventWorld,items:renderState.items||[]}:eventWorld,renderState?.elapsed??elapsed,dt,camera);}if(ms-lastUI>100){updateUI();lastUI=ms;}networkTick(ms);renderer.render(scene,camera);window.__racePerf.frameWorkMs=+(performance.now()-frameStart).toFixed(2);window.__racePerf.drawCalls=renderer.info.render.calls;window.__racePerf.triangles=renderer.info.render.triangles;}
function pause(){} // Shared races never pause when one viewer changes focus.
window.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA'].includes(e.target.tagName))return;if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))e.preventDefault();keys.add(e.code);if(!e.repeat&&e.code==='KeyR'&&canDrive)resetRequested=true;});
window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>keys.clear());
$('camera').onclick=()=>{overview=!overview;$('camera').textContent=overview?'Камера: вся трасса':'Камера: следом';};
for(const btn of document.querySelectorAll('#touch button')){btn.onpointerdown=e=>{e.preventDefault();btn.setPointerCapture(e.pointerId);keys.add(btn.dataset.key);};btn.onpointerup=btn.onpointercancel=()=>keys.delete(btn.dataset.key);}
let resetRequested=false,resetSeq=0;const resetSeen={};
const neutral=()=>({gas:0,brake:0,steer:0,drift:false,boost:false});
function inputMap(){const result={};for(let i=0;i<roster.length;i++){const id=roster[i].uid;const u=i===localId&&canDrive?controls():performance.now()-(receivedAt[id]||0)<500?remoteInputs[id]:neutral();result[i]=u||neutral();if(u?.seq)inputAck[id]=u.seq;if(u?.reset&&u.reset!==resetSeen[id]){resetSeen[id]=u.reset;resetCar(circuit,cars[i]);}}if(resetRequested&&canDrive){resetRequested=false;resetCar(circuit,cars[localId]);}return result;}
function networkTick(ms){if(ms-lastSend< (authority?33:33))return;lastSend=ms;if(canDrive&&!authority){if(resetRequested){resetRequested=false;resetSeq++;}post({type:'input',input:{...controls(),reset:resetSeq,seq:++inputSeq}});}if(authority)post({type:'snapshot',data:{seq:seq++,elapsed,mode,countdown,done,ack:inputAck,cars:cars.map(c=>({...c})),items:eventWorld.items.map(e=>({...e,hits:[...e.hits]}))}});}
window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==parent||e.data?.dpRace!==1)return;const m=e.data;
 if(m.type==='init'&&!initialized&&Array.isArray(m.roster)&&m.roster.length>0&&m.roster.length<=12){session=m.id;roster=m.roster;localId=Math.max(0,Math.min(roster.length-1,m.localId));authority=!!m.authority;canDrive=!!m.canDrive;seed=m.seed;$('color').value=roster[localId].color;document.documentElement.style.setProperty('--accent',roster[localId].color);$('calm').checked=m.bots.calm!==false;$('aggressive').checked=m.bots.aggressive!==false;build();initialized=true;mode='countdown';countdown=3;$('startPanel').hidden=true;return;}
 if(m.id!==session)return;
 if(m.type==='stalled'){stalled=true;keys.clear();$('banner').textContent='ВЕДУЩИЙ ОТКЛЮЧИЛСЯ';return;}
 if(m.type==='inputs'&&authority){const incoming=m.inputs||{};for(const id of Object.keys(incoming)){if(!remoteInputs[id]||incoming[id].t!==remoteInputs[id].t)receivedAt[id]=performance.now();}remoteInputs=incoming;return;}
 if(m.type==='snapshot'&&!authority){const d=m.data;if(d&&Number.isSafeInteger(d.seq)&&d.seq>lastAppliedSeq&&(!pendingSnapshot||d.seq>pendingSnapshot.seq))pendingSnapshot=d;}
});
function constrainPrediction(car,time){eventWorld.time=time;eventWorld.constrain([car]);}
function applySnapshot(d){
 if(!d||!Array.isArray(d.cars)||d.cars.length!==cars.length||!Number.isFinite(d.elapsed)||d.elapsed<elapsed)return;
 if(d.cars.some((c,i)=>!c||c.id!==i||['x','z','vx','vz','heading'].some(k=>!Number.isFinite(c[k]))))return;
 lastAppliedSeq=d.seq;processedSnapshots++;window.__racePerf.snapshotsApplied=processedSnapshots;stalled=false;
 snapshots.push(d,performance.now());elapsed=d.elapsed;mode=d.mode;countdown=d.countdown;done=d.done;
 eventWorld.time=elapsed;eventWorld.items=(d.items||[]).map(e=>({...e,hits:new Set(e.hits||[])}));
 for(let i=0;i<cars.length;i++){
  const c=cars[i],next=d.cars[i],old={x:c.x,z:c.z,heading:c.heading};
  if((next.cashUntil||0)>(c.cashUntil||0))locationView.emit('money',c,{});
  if((next.blastUntil||0)>(c.blastUntil||0)&&i===localId){shake=1.25;thud(22);}
  if((next.contactCooldown||0)>(c.contactCooldown||0)+.2&&i===localId){shake=.7;thud(15);}
  if(i===localId&&canDrive&&(mode==='racing'||mode==='finished')){
   const before=visualError.pose(c);
   if(mode==='racing')prediction.accept(circuit,c,next,elapsed,constrainPrediction);
   else {Object.assign(c,next);prediction.reset(elapsed);}
   correctionLast=Math.hypot(old.x-c.x,old.z-c.z);correctionMax=Math.max(correctionMax,correctionLast);
   visualError.capture(before,c);
  }else{
   Object.assign(c,next,old);
   if(i===localId){prediction.reset(elapsed);visualError.clear();}
  }
 }
 if(mode==='countdown')$('banner').textContent=countdown>0?Math.ceil(countdown):'ГАЗ!';else if(mode==='racing')$('banner').textContent='';
}
window.addEventListener('pointerdown',()=>{if(!thudAudio){const AC=window.AudioContext||window.webkitAudioContext;if(AC)thudAudio=new AC();}thudAudio?.resume();},{once:true});
window.__racePerf={version:5,fps:0,drawCalls:0,triangles:0,frameWorkMs:0,snapshotsApplied:0,quality:'Обычная',batches:null};
const qualityButton=document.createElement('button');qualityButton.textContent='Графика: обычная';qualityButton.onclick=()=>setQuality((quality+1)%3);document.querySelector('.help').append(qualityButton);
function setQuality(level){quality=level;for(const g of meshes)if(g.userData.shadowBlob)g.userData.shadowBlob.visible=level>0;renderer.setPixelRatio(Math.min(devicePixelRatio,[1.25,1,.75][level]));const shadows=level===0;if(renderer.shadowMap.enabled!==shadows){renderer.shadowMap.enabled=shadows;scene.traverse(o=>{if(o.material){for(const m of (Array.isArray(o.material)?o.material:[o.material]))m.needsUpdate=true;}});}renderer.setSize(innerWidth,innerHeight);const labels=['обычная','лёгкая','минимальная'];qualityButton.textContent='Графика: '+labels[level];window.__racePerf.quality=labels[level];}
post({type:'ready'});
function resize(){renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();}window.addEventListener('resize',resize);resize();requestAnimationFrame(tick);
