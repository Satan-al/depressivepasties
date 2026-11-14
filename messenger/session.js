import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { loginCredentials, authErrorMessage } from '../dp-auth.js';
import { MessengerWindow } from './messenger.js';

const config = {
  apiKey: 'AIzaSyAcrLDWHWA_diaVHQwtFUeWqq3WAzMYBnc',
  authDomain: 'dpgames-66d73.firebaseapp.com',
  projectId: 'dpgames-66d73',
  storageBucket: 'dpgames-66d73.firebasestorage.app',
  appId: '1:734650657253:web:6c98ad8e72a4156e7be70c'
};
const app = getApps().find(item => item.name === '[DEFAULT]') || initializeApp(config);
const auth = getAuth(app);
const form = document.getElementById('messengerLogin');
const status = document.getElementById('loginStatus');
let view;
let signingIn = false;

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (signingIn) return;
  signingIn = true;
  form.querySelector('button').disabled = true;
  status.textContent = '';
  try {
    const credentials = await loginCredentials(form.elements.name.value, form.elements.password.value);
    await signInWithEmailAndPassword(auth, credentials.email, credentials.password);
    form.elements.password.value = '';
  } catch (error) { status.textContent = authErrorMessage(error); }
  finally { signingIn = false; form.querySelector('button').disabled = false; }
});

onAuthStateChanged(auth, user => {
  view?.close(); view = null;
  form.hidden = Boolean(user && !user.isAnonymous);
  if (user && !user.isAnonymous) {
    const roomId = /^#[A-Za-z0-9_-]{1,128}$/.test(location.hash) ? location.hash.slice(1) : null;
    view = new MessengerWindow({ auth, roomId, onSignOut: () => signOut(auth) });
    view.start();
  }
});
