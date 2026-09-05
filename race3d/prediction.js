import {step,angle,clamp} from './engine.js?v=3';
export const STEP=1/120;
export function predict(track,car,input,dt,time){step(track,[car],{players:{[car.id]:input}},dt,time);}

// The host samples input on its own fixed clock. Its input acknowledgement is
// NOT an acknowledgement of client physics steps. Replay only the time after
// the snapshot, on the same 120 Hz simulation timeline.
export class ClientPrediction {
 constructor(){this.tick=0;this.serverTick=0;this.frames=[];this.maxAhead=30;}
 get time(){return this.tick*STEP;}
 advance(track,car,input,constrain=()=>{}){
  if(this.tick>=this.serverTick+this.maxAhead)return false;
  this.tick++;this.frames.push({tick:this.tick,input});
  predict(track,car,input,STEP,this.time);constrain(car,this.time);return true;
 }
 accept(track,car,server,time,constrain=()=>{}){
  const serverTick=Math.round(time/STEP);
  if(serverTick<this.serverTick)return false;
  const target=Math.max(serverTick,Math.min(this.tick,serverTick+this.maxAhead));
  this.frames=this.frames.filter(f=>f.tick>serverTick&&f.tick<=target);
  Object.assign(car,server);this.serverTick=serverTick;this.tick=serverTick;
  for(const frame of this.frames){
   this.tick=frame.tick;predict(track,car,frame.input,STEP,this.time);constrain(car,this.time);
  }
  return true;
 }
 reset(time=0){this.tick=this.serverTick=Math.round(time/STEP);this.frames=[];}
}

// Keep drawing the pre-correction pose, then converge at a bounded speed.
// In particular, correcting a car that is ahead must not reverse its motion.
// Physics, impulses and race results always remain authoritative.
export class VisualCorrection {
 constructor(){this.x=0;this.z=0;this.heading=0;}
 pose(car){return {...car,x:car.x+this.x,z:car.z+this.z,heading:car.heading+this.heading};}
 capture(before,car){
  this.x=before.x-car.x;this.z=before.z-car.z;this.heading=angle(before.heading-car.heading);
  if(Math.hypot(this.x,this.z)>25)this.clear(); // genuine relocation / long disconnect
 }
 clear(){this.x=this.z=this.heading=0;}
 decay(dt,car){
  const factor=1-Math.exp(-dt*12),speed=Math.hypot(car.vx,car.vz);
  const fx=speed>1?car.vx/speed:Math.cos(car.heading),fz=speed>1?car.vz/speed:Math.sin(car.heading);
  const along=this.x*fx+this.z*fz,side=-this.x*fz+this.z*fx;
  const forward=clamp(-along*factor,-(speed>2?speed*.35:6)*dt,10*dt);
  const lateral=clamp(-side*factor,-10*dt,10*dt);
  this.x+=forward*fx-lateral*fz;this.z+=forward*fz+lateral*fx;
  this.heading*=1-factor;
 }
}
