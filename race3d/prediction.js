import {step} from './engine.js';
export function predict(track,car,input,dt,time){step(track,[car],{players:{[car.id]:input}},dt,time);}
export function reconcile(track,car,server,pending,ack,time){const remaining=pending.filter(f=>f.seq>ack).slice(-24);Object.assign(car,server);let t=time;for(const f of remaining){t+=f.dt;predict(track,car,f.input,f.dt,t);}return remaining;}
