// Keep listeners alive across sign-in/sign-out without opening private data before login.
import * as firebase from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';
export * from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';

let authorized = false;
const subscriptions = new Set();

function subscribe(method, args) {
  const entry = { stop: null, disposed: false };
  const callback = args[1];
  entry.start = () => {
    if (entry.stop || entry.disposed || !authorized) return;
    const guarded = [...args];
    guarded[1] = (...values) => { if (authorized && !entry.disposed) callback(...values); };
    entry.stop = firebase[method](...guarded);
  };
  subscriptions.add(entry);
  entry.start();
  return () => {
    entry.disposed = true;
    entry.stop?.();
    entry.stop = null;
    subscriptions.delete(entry);
  };
}

export const onValue = (...args) => subscribe('onValue', args);
export const onChildAdded = (...args) => subscribe('onChildAdded', args);
export const onChildChanged = (...args) => subscribe('onChildChanged', args);
export const onChildRemoved = (...args) => subscribe('onChildRemoved', args);
export function setRealtimeAuthorized(value) {
  authorized = value === true;
  for (const entry of subscriptions) {
    if (authorized) entry.start();
    else { entry.stop?.(); entry.stop = null; }
  }
}
