import {random,at,nearest,clamp} from './engine.js';
import {CAR_RADIUS,SYRUP_RADIUS,PIGEON_RADIUS,STUDENT_HALF_ALONG,STUDENT_HALF_ACROSS,syrupRadius,pigeonRadius,studentCenter} from './hazards.js?v=5';
export const COUNTRIES=[
{id:'ca',name:'Канада',subtitle:'Осторожно: кленовый сироп',ground:'#746242',road:'#424052',curbs:['#f0ddd3','#cc4e44'],sky:'#343248',trees:['#da6937','#e9af42','#b84736']},
{id:'rs',name:'Сербия',subtitle:'Чевапы горячие. Студенты идут.',ground:'#617453',road:'#56505b',curbs:['#ece3d1','#da5c52'],sky:'#303445',trees:['#50975d','#91af58','#bf9f5c']},
{id:'ua',name:'Украина',subtitle:'Следи за метками на дороге',ground:'#494b43',road:'#43464b',curbs:['#4192d1','#efd34e'],sky:'#202630',trees:['#6d9166','#a3aa65','#526b59']},
{id:'ru',name:'Россия',subtitle:'Око следит. Дроны мешают.',ground:'#5c6167',road:'#3e424d',curbs:['#b9bcc6','#73798c'],sky:'#272c38',trees:['#70817c','#5d706a','#8b8e7d']},
{id:'sg',name:'Сингапур',subtitle:'Голуби дорого обходятся',ground:'#213948',road:'#252e45',curbs:['#36e1d0','#da57e5'],sky:'#111426',trees:['#26a195','#398087','#54b6ac']}
];
export function countryFor(seed){return COUNTRIES[Math.floor(random(seed+'location')()*COUNTRIES.length)];}
export class Events{
 constructor(t,country,emit=()=>{}){this.track=t;this.country=country;this.emit=emit;this.rng=random(t.seed+'events');this.layoutRng=random(t.seed+'hazardLayout');this.items=[];this.next=country.id==='ua'?2:country.id==='rs'?8:3;this.serial=0;this.time=0;}
 spawn(time,cars,type){const r=this.rng,car=cars[Math.floor(r()*cars.length)],speed=Math.hypot(car.vx,car.vz);type=type||({ca:'syrup',rs:'students',ua:'missile',sg:'pigeons'}[this.country.id]||(r()<.5?'police':'drone'));const ahead=type==='missile'?Math.max(22,speed*2.7):30+r()*15,p=at(this.track,car.lastS+ahead),theta=r()*Math.PI*2;
 const e={id:++this.serial,type,born:time,x:p.x,z:p.z,heading:p.heading,s:((car.lastS+ahead)%this.track.length+this.track.length)%this.track.length,target:car.id,hits:new Set(),done:false,duration:{syrup:13,students:8,missile:4.2,police:9,drone:8,pigeons:10}[type]};
 if(type==='syrup'||type==='pigeons')this.placeRoadside(e,time);
 if(type==='students')e.direction=this.layoutRng()<.5?-1:1;
 if(type==='police'){e.x=car.x+Math.cos(theta)*27;e.z=car.z+Math.sin(theta)*27;}
 if(type==='drone'){e.x=car.x+Math.cos(theta)*30;e.z=car.z+Math.sin(theta)*30;e.dx=-Math.cos(theta);e.dz=-Math.sin(theta);}
 this.items.push(e);return e;
 }
 placeRoadside(e,time){
  const length=this.track.length,r=this.layoutRng,chosenSide=r()<.5?-1:1;
  const nearby=this.items.filter(v=>(v.type==='syrup'||v.type==='pigeons')&&time-v.born<v.duration);
  // Nearby patches share a side, leaving one continuous route past a cluster.
  // If two existing clusters disagree, move the new patch further along.
  let side=chosenSide;
  for(let tries=0;tries<=Math.ceil(length/28);tries++){
   const neighbours=nearby.filter(v=>{const s=Number.isFinite(v.s)?v.s:nearest(this.track,v.x,v.z).s,d=Math.abs(e.s-s);return Math.min(d,length-d)<28;});
   side=neighbours[0]?.laneSide||chosenSide;
   if(neighbours.every(v=>!v.laneSide||v.laneSide===side))break;
   e.s=(e.s+28)%length;
  }
  const p=at(this.track,e.s),lane=side*(2.35+r()*.3);
  e.x=p.x+p.nx*lane;e.z=p.z+p.nz*lane;e.heading=p.heading;e.laneSide=side;
  e.radius=e.type==='syrup'?SYRUP_RADIUS*(.85+r()*.15):PIGEON_RADIUS;
 }
 update(dt,time,cars){this.time=time;for(const c of cars){c.syrup=false;c.crossing=false;c.hardStop=time<(c.policeUntil||0);c.cashSlow=time<(c.cashUntil||0);c.jammed=time<(c.jamUntil||0);}
 if(time>=this.next){this.spawn(time,cars);this.next=time+(this.country.id==='ua'?2.5+this.rng()*1.5:this.country.id==='rs'?12+this.rng()*6:4+this.rng()*2);}
 this.items=this.items.filter(e=>time-e.born<e.duration);
 for(const e of this.items){const age=time-e.born;
 if(e.type==='police'&&!e.done){const target=cars.find(c=>c.id===e.target)||cars[0],dx=target.x-e.x,dz=target.z-e.z,d=Math.hypot(dx,dz);e.heading=Math.atan2(dz,dx);const move=Math.min(d,34*dt);e.x+=dx/(d||1)*move;e.z+=dz/(d||1)*move;if(d<3.8){e.done=true;target.policeUntil=time+3+this.rng()*2;e.duration=Math.max(e.duration,age+(target.policeUntil-time)+.5);target.hardStop=true;target.stopX=target.x;target.stopZ=target.z;this.emit('police',target,e);}}
 if(e.type==='drone'){// Sweeping flight; its turn rate is limited so drivers can dodge.
 const target=cars.find(c=>c.id===e.target)||cars[0];if(age<2.4){const d=Math.hypot(target.x-e.x,target.z-e.z)||1;e.dx+=( (target.x-e.x)/d-e.dx)*dt*2;e.dz+=((target.z-e.z)/d-e.dz)*dt*2;}e.x+=e.dx*30*dt;e.z+=e.dz*30*dt;e.heading=Math.atan2(e.dz,e.dx);}
 if(e.type==='missile'&&age>=2.7&&!e.done){e.done=true;for(const c of cars){const dx=c.x-e.x,dz=c.z-e.z,d=Math.hypot(dx,dz);if(d<8){const nx=d>.1?dx/d:Math.cos(c.heading+1),nz=d>.1?dz/d:Math.sin(c.heading+1),force=16*(1-d/12);c.vx+=nx*force;c.vz+=nz*force;c.stun=Math.max(c.stun||0,1);c.blastUntil=time+.8;this.emit('blast',c,e);}}}
 for(const c of cars){const d=Math.hypot(c.x-e.x,c.z-e.z);
 if(e.type==='syrup'&&age>.8&&d<syrupRadius(e)+CAR_RADIUS)c.syrup=true;
 if(e.type==='drone'&&d<3.7&&!e.hits.has(c.id)){e.hits.add(c.id);c.jamUntil=time+3+this.rng()*2;c.jammed=true;this.emit('drone',c,e);}
 if(e.type==='pigeons'&&age>1.2&&d<pigeonRadius(e)&&!e.hits.has(c.id)){e.hits.add(c.id);c.cashUntil=time+2.6;c.cashSlow=true;this.emit('money',c,e);}
 }
 }
 this.constrain(cars);
 }
 constrain(cars){for(const c of cars){c.crossing=false;if(c.hardStop){c.vx=0;c.vz=0;if(Number.isFinite(c.stopX)){c.x=c.stopX;c.z=c.stopZ;}}}
 for(const e of this.items){if(e.type!=='students')continue;const group=studentCenter(e,this.time);if(!group.active)continue;const fx=Math.cos(e.heading),fz=Math.sin(e.heading);for(const c of cars){const dx=c.x-group.x,dz=c.z-group.z,along=dx*fx+dz*fz,across=-dx*fz+dz*fx;if(Math.abs(along)<STUDENT_HALF_ALONG&&Math.abs(across)<STUDENT_HALF_ACROSS){const side=along<0?-1:1;c.x=group.x+fx*side*STUDENT_HALF_ALONG-fz*across;c.z=group.z+fz*side*STUDENT_HALF_ALONG+fx*across;c.vx=c.vz=0;c.crossing=true;}}}
 }
 status(c){if(c.hardStop)return ['проверка телефона',Math.ceil(c.policeUntil-this.time)];if(c.crossing)return['Студенты переходят',null];if(c.jammed)return['РЭБ',Math.ceil(c.jamUntil-this.time)];if(c.cashSlow)return['а нахуя ты их кормил',Math.ceil(c.cashUntil-this.time)];if(c.syrup)return['кленовый сироп',null];if(this.time<(c.blastUntil||0))return['Ударная волна',null];return null;}
}
