import {angle,clamp} from './engine.js?v=3';

// A monotonic render clock between past snapshots. Packet arrival must not
// directly move a spectator's car or camera backwards.
export class SnapshotBuffer {
 constructor(){this.frames=[];this.time=null;this.delay=.1;this.gaps=[];this.arrival=null;this.interval=.033;this.jitter=0;}
 push(data,now){
  const last=this.frames.at(-1);
  if(last&&(data.seq<=last.seq||data.elapsed<last.elapsed))return false;
  if(last&&data.elapsed>last.elapsed&&this.arrival!==null){
   const gap=Math.max(0,(now-this.arrival)/1000),interval=data.elapsed-last.elapsed;
   this.gaps.push(gap*1000);if(this.gaps.length>90)this.gaps.shift();
   this.interval+=(Math.min(interval,.3)-this.interval)*.1;
   this.jitter+=(Math.abs(gap-interval)-this.jitter)*.1;
   this.delay=clamp(this.interval*2+this.jitter*2,.1,.25);
  }
  this.arrival=now;
  if(last?.elapsed===data.elapsed)this.frames.pop();
  this.frames.push(data);if(this.frames.length>64)this.frames.shift();
  if(this.time===null)this.time=Math.max(0,data.elapsed-this.delay);
  return true;
 }
 advance(dt){
  const latest=this.frames.at(-1);if(!latest)return null;
  if(latest.mode==='racing'||latest.mode==='finished'){
   const lead=latest.elapsed-this.time;
   this.time=Math.max(this.time,Math.min(latest.elapsed+(latest.mode==='racing'?.075:0),this.time+dt*clamp(1+(lead-this.delay)*2,.9,1.1)));
  }else this.time=Math.max(this.time,latest.elapsed);
  while(this.frames.length>2&&this.frames[1].elapsed<=this.time)this.frames.shift();
  let a=this.frames[0],b=a;
  for(const frame of this.frames){if(frame.elapsed<=this.time)a=frame;else{b=frame;break;}b=a;}
  if(a===b){
   const age=a.mode==='racing'?clamp(this.time-a.elapsed,0,.075):0;
   return {...a,elapsed:this.time,cars:a.cars.map(c=>({...c,x:c.x+c.vx*age,z:c.z+c.vz*age}))};
  }
  const u=clamp((this.time-a.elapsed)/(b.elapsed-a.elapsed),0,1);
  const blend=(p,q)=>({...p,x:p.x+(q.x-p.x)*u,z:p.z+(q.z-p.z)*u,heading:p.heading+angle(q.heading-p.heading)*u});
  const itemsById=new Map((b.items||[]).map(e=>[e.id,e]));
  return {...a,elapsed:this.time,cars:a.cars.map((c,i)=>blend(c,b.cars[i])),items:(a.items||[]).map(e=>itemsById.has(e.id)?blend(e,itemsById.get(e.id)):e)};
 }
 stats(now){
  const sorted=[...this.gaps].sort((a,b)=>a-b),mean=this.gaps.reduce((a,b)=>a+b,0)/(this.gaps.length||1);
  return {snapshotHz:mean?+(1000/mean).toFixed(1):0,snapshotGapP95Ms:Math.round(sorted[Math.floor(sorted.length*.95)]||0),snapshotAgeMs:this.arrival===null?0:Math.round(now-this.arrival),interpolationMs:Math.round(this.delay*1000)};
 }
}
