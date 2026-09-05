import {clamp} from './engine.js';

// Shared dimensions for drawing and collision checks, in world metres.
export const CAR_RADIUS=1.2;
export const SYRUP_RADIUS=2;
export const PIGEON_RADIUS=2.6;
export const STUDENT_HALF_ALONG=2.8; // includes room for the car to brake
export const STUDENT_HALF_ACROSS=2.3;
export function syrupRadius(e){return e.radius??SYRUP_RADIUS;}
export function pigeonRadius(e){return e.radius??PIGEON_RADIUS;}
export function studentCenter(e,time){
 const age=time-e.born,walk=(e.direction||1)*(-7.5+clamp((age-1)/5.8,0,1)*15);
 return {x:e.x-Math.sin(e.heading)*walk,z:e.z+Math.cos(e.heading)*walk,active:age>=1&&age<=6.8};
}
export function studentOffset(i){return {along:(i%3-1)*.75,across:(Math.floor(i/3)-1)*.65};}
