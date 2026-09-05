import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, setPersistence, inMemoryPersistence, createUserWithEmailAndPassword, deleteUser } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { ref, update, serverTimestamp } from './dp-realtime.js';

export function normalizeLoginName(value) {
  const name = String(value || '').normalize('NFKC').trim();
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name)) throw new Error('Имя: от 1 до 32 букв, цифр, _ или -.');
  return name.toLowerCase().replaceAll('ё', 'е');
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function loginCredentials(name, password) {
  const normalized = normalizeLoginName(name);
  if (typeof password !== 'string' || password.length < 4 || password.length > 128) {
    throw new Error('Пароль: от 4 до 128 символов.');
  }
  // Protocol encoding lets existing four-character passwords use Firebase's password provider.
  // This is NOT password storage or extra entropy. Firebase verifies and hashes the credential.
  // Never persist this derived credential: it is also a login secret.
  return {
    email: `${await sha256(normalized)}@login.depressivepasties.invalid`,
    password: await sha256(`DepressivePasties:password:v1:${normalized}:${password}`)
  };
}

export function safeColor(value, fallback = '#16c7b7') {
  return /^#[0-9a-f]{6}$/i.test(String(value)) ? value : fallback;
}

export function safeImageSource(value) {
  const source = String(value || '');
  if (/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(source) && source.length <= 100000) return source;
  if (/^images\/[a-zA-Z0-9_.-]+\.(png|jpe?g|webp)$/i.test(source)) return source;
  return '';
}

let registering = false;
export async function registerMember({ app, db, auth, account, name, password }) {
  if (!auth.currentUser || !account?.enabled || account.role !== 'host' || account.uid !== auth.currentUser.uid) {
    throw new Error('Новых пользователей добавляет хост.');
  }
  if (registering) throw new Error('Предыдущая регистрация ещё выполняется.');
  registering = true;
  let registrationApp;
  let user;
  let approved = false;
  try {
    if (normalizeLoginName(name) === 'host') throw new Error('Имя host зарезервировано. Выбери другое.');
    const credential = await loginCredentials(name, password);
    registrationApp = initializeApp(app.options, `register-${crypto.randomUUID()}`);
    const registrationAuth = getAuth(registrationApp);
    await setPersistence(registrationAuth, inMemoryPersistence);
    ({ user } = await createUserWithEmailAndPassword(registrationAuth, credential.email, credential.password));
    const displayName = String(name).normalize('NFKC').trim();
    // Atomic admission + profile creation. Rules allow only an admitted host to do this.
    await update(ref(db), {
      [`access/${user.uid}`]: { name: displayName, role: 'member', enabled: true, version: 1, createdAt: serverTimestamp() },
      [`sessions/DepressivePasties/users/${user.uid}`]: { name: displayName, color: '#16c7b7', emoji: '🐶', createdAt: serverTimestamp() }
    });
    approved = true;
    return displayName;
  } catch (error) {
    if (user && !approved) { try { await deleteUser(user); } catch {} }
    if (error.code === 'auth/email-already-in-use') throw new Error('Это имя уже занято. Существующий пароль не изменён.');
    if (String(error.code).includes('permission')) throw new Error('Нет права регистрации. Проверь вход в аккаунт хоста.');
    throw error;
  } finally {
    if (registrationApp) await deleteApp(registrationApp).catch(() => {});
    registering = false;
  }
}

export function authErrorMessage(error) {
  const code = String(error?.code || '');
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-login-credentials'].includes(code)) return 'Не получилось войти. Проверь имя и пароль.';
  if (code === 'auth/too-many-requests') return 'Слишком много попыток. Подожди немного и попробуй снова.';
  if (code === 'auth/network-request-failed') return 'Не удалось связаться с сервером. Проверь соединение и попробуй ещё раз.';
  if (code === 'auth/operation-not-allowed') return 'Вход пока не настроен. Сообщи хосту.';
  if (code.includes('permission') || code === 'auth/user-disabled') return 'Этот аккаунт пока не допущен. Обратись к хосту.';
  return code ? 'Вход не завершён. Попробуй ещё раз.' : String(error?.message || 'Не удалось войти.');
}
