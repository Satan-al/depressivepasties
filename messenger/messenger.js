const API_DEFAULT = 'https://dp-telegram-bot.fly.dev/messenger/api';
const ASSETS = new URL('./icons/', import.meta.url);
let windowLevel = 18000;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tool(icon, label, action) {
  const button = element('button', 'dp-tool');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  const image = element('img');
  image.src = new URL(icon + '.svg', ASSETS).href;
  image.alt = '';
  button.append(image);
  button.addEventListener('click', action);
  return button;
}

function avatar(profiles, ownUid = '') {
  const box = element('span', 'dp-avatar');
  const selected = profiles.filter(profile => profile.uid !== ownUid);
  const items = (selected.length ? selected : profiles).slice(0, 4);
  if (items.length > 1) box.classList.add('dp-cluster');
  for (const profile of items) {
    const face = element('span', 'dp-face');
    face.style.borderColor = /^#[0-9a-f]{6}$/i.test(profile.color) ? profile.color : '#16c7b7';
    const emoji = String(profile.emoji || '');
    if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(emoji) && emoji.length < 100001) {
      const image = element('img'); image.src = emoji; image.alt = ''; face.append(image);
    } else if (/^images\/[A-Za-z0-9_.-]+\.(png|jpe?g|webp)$/i.test(emoji)) {
      const image = element('img'); image.src = new URL('../' + emoji, import.meta.url).href; image.alt = ''; face.append(image);
    } else {
      face.textContent = emoji && emoji.length < 16 ? emoji : profile.name.slice(0, 1);
    }
    box.append(face);
  }
  return box;
}

export function loadMessengerStyle() {
  if (document.querySelector('link[data-dp-messenger]')) return;
  const link = element('link');
  link.rel = 'stylesheet';
  link.href = new URL('./messenger.css', import.meta.url).href;
  link.dataset.dpMessenger = '1';
  document.head.append(link);
}

export class MessengerWindow {
  constructor({ auth, floating = false, roomId = null, detached = false, onClose, onSignOut, apiBase } = {}) {
    loadMessengerStyle();
    this.auth = auth;
    this.floating = floating;
    this.detached = detached;
    this.roomId = roomId;
    this.apiBase = (apiBase || window.DP_MESSENGER_API || API_DEFAULT).replace(/\/$/, '');
    this.onClose = onClose;
    this.onSignOut = onSignOut;
    this.rooms = [];
    this.members = [];
    this.messages = new Map();
    this.imageUrls = new Map();
    this.requests = new Set();
    this.children = new Set();
    this.selectedMembers = new Set();
    this.closed = false;
    this.version = 0;
    this.root = element('section', 'dp-messenger' + (floating ? ' dp-floating' : ' dp-fullscreen') + (detached ? ' dp-detached' : ''));
    this.root.setAttribute('aria-label', 'DepressivePasties Messenger');
    this.root.style.zIndex = String(++windowLevel);
    this.root.innerHTML = '<header class="dp-window-head"><strong>DepressivePasties <span>Messenger</span></strong><nav></nav></header><div class="dp-layout"><aside class="dp-sidebar"><div class="dp-inbox-head"><h2>Беседы</h2></div><input class="dp-search" type="search" placeholder="Поиск беседы" aria-label="Поиск беседы"><div class="dp-rooms"></div><div class="dp-self"></div></aside><main class="dp-conversation"><header class="dp-room-head"><div class="dp-room-title"></div><nav></nav></header><div class="dp-notice" role="status"></div><div class="dp-messages"><div class="dp-empty">Выбери беседу</div></div><form class="dp-compose"><div class="dp-attachment" hidden></div><div class="dp-compose-row"><textarea rows="1" maxlength="4000" placeholder="Сообщение" aria-label="Сообщение"></textarea></div></form></main></div><div class="dp-new-room" hidden><header><h2>Новая беседа</h2></header><div class="dp-new-body"><div class="dp-modes" role="group" aria-label="Тип беседы"><button type="button" data-kind="direct" aria-pressed="true">Личная</button><button type="button" data-kind="group" aria-pressed="false">Группа</button></div><input class="dp-group-name" maxlength="80" placeholder="Название группы" aria-label="Название группы" hidden><input class="dp-member-search" type="search" placeholder="Найти участника" aria-label="Найти участника"><div class="dp-member-list"></div><div class="dp-new-error" role="status"></div></div><footer><button class="dp-primary dp-create" type="button">Создать беседу</button></footer></div>';
    this.find = selector => this.root.querySelector(selector);
    this.notice = this.find('.dp-notice');
    this.messageList = this.find('.dp-messages');
    this.textarea = this.find('textarea');
    this.fileInput = element('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/png,image/jpeg,image/webp';
    this.fileInput.hidden = true;
    this.root.append(this.fileInput);
    const headNav = this.find('.dp-window-head nav');
    if (floating) headNav.append(tool('arrow-up-right', 'Открыть страницу мессенджера', () => {
      window.open(new URL('./index.html' + (this.roomId ? '#' + this.roomId : ''), import.meta.url).href, '_blank', 'noopener');
    }));
    if (onSignOut) headNav.append(tool('log-out', 'Выйти', onSignOut));
    if (floating) headNav.append(tool('x', 'Закрыть', () => this.close()));
    this.find('.dp-inbox-head').append(tool('plus', 'Новая беседа', () => this.showCreate()));
    this.find('.dp-new-room header').append(tool('x', 'Закрыть', () => { this.find('.dp-new-room').hidden = true; }));
    this.find('.dp-room-head').prepend(tool('arrow-left', 'К беседам', () => {
      this.roomId = null; this.version++; this.root.classList.remove('dp-has-room'); this.renderHeader();
    }));
    this.find('.dp-search').addEventListener('input', () => this.renderRooms());
    this.find('.dp-member-search').addEventListener('input', () => this.renderMemberChoices());
    this.root.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => {
      this.kind = button.dataset.kind;
      this.selectedMembers.clear();
      this.root.querySelectorAll('[data-kind]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      this.find('.dp-group-name').hidden = this.kind !== 'group';
      this.renderMemberChoices();
    }));
    this.find('.dp-create').addEventListener('click', () => this.createRoom());
    this.attachButton = tool('paperclip', 'Прикрепить картинку', () => this.fileInput.click());
    this.sendButton = tool('send', 'Отправить', () => this.send());
    this.sendButton.classList.add('dp-send');
    this.find('.dp-compose-row').prepend(this.attachButton);
    this.find('.dp-compose-row').append(this.sendButton);
    this.find('.dp-compose').addEventListener('submit', event => { event.preventDefault(); this.send(); });
    this.textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.send(); }
    });
    this.textarea.addEventListener('input', () => {
      this.textarea.style.height = 'auto';
      this.textarea.style.height = Math.min(this.textarea.scrollHeight, 120) + 'px';
    });
    this.fileInput.addEventListener('change', () => this.chooseImage(this.fileInput.files[0]));
    this.root.addEventListener('paste', event => {
      const file = [...(event.clipboardData?.files || [])].find(item => /^image\/(png|jpeg|webp)$/.test(item.type));
      if (file && this.roomId) { event.preventDefault(); this.chooseImage(file); }
    });
    this.root.addEventListener('pointerdown', () => { this.root.style.zIndex = String(++windowLevel); });
    this.visibility = () => { if (!document.hidden) this.refresh(); };
    document.addEventListener('visibilitychange', this.visibility);
    if (floating) this.makeDraggable();
    document.body.append(this.root);
    this.renderHeader();
  }

  async request(path, { method = 'GET', body, binary = false } = {}) {
    if (this.closed) throw new Error('Окно закрыто');
    const user = this.auth?.currentUser;
    if (!user) throw new Error('Войди в аккаунт сайта');
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const token = await user.getIdToken();
      const headers = { Authorization: 'Bearer ' + token };
      const form = body instanceof FormData;
      if (body && !form) headers['Content-Type'] = 'application/json';
      const response = await fetch(this.apiBase + path, {
        method, headers, body: body ? (form ? body : JSON.stringify(body)) : undefined,
        signal: controller.signal, credentials: 'omit', cache: 'no-store'
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const message = response.status === 503 ? 'Мессенджер пока недоступен. Попробуй ещё раз.'
          : response.status === 401 ? 'Сессия завершилась. Войди в аккаунт ещё раз.'
          : response.status === 403 ? 'Нет доступа к этой беседе.'
          : error.error || 'Не удалось выполнить запрос.';
        throw new Error(message);
      }
      return binary ? response.blob() : response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Сервер не ответил. Сообщение можно отправить повторно.');
      if (error instanceof TypeError) throw new Error('Нет соединения с мессенджером.');
      throw error;
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }

  async start() {
    try {
      const data = await this.request('/me');
      this.user = data.user;
      this.telegramEnabled = data.telegramEnabled;
      this.find('.dp-self').replaceChildren(avatar([this.user]), element('span', '', this.user.name));
      await this.refresh();
    } catch (error) { this.showError(error); }
    this.schedule();
    return this;
  }

  schedule() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (!document.hidden) await this.refresh();
      this.schedule();
    }, document.hidden ? 12000 : 3000);
  }

  async refresh() {
    if (this.loading || this.closed) return;
    this.loading = true;
    try {
      if (!this.user) {
        const data = await this.request('/me'); this.user = data.user; this.telegramEnabled = data.telegramEnabled;
        this.find('.dp-self').replaceChildren(avatar([this.user]), element('span', '', this.user.name));
      }
      const pending = this.rooms.find(room => room.id === this.roomId)?.telegram?.state !== 'ready';
      if (!this.roomsUpdated || pending || Date.now() - this.roomsUpdated > 9000) {
        this.rooms = (await this.request('/rooms')).rooms;
        this.roomsUpdated = Date.now();
        this.renderRooms(); this.renderHeader();
      }
      if (this.roomId) await this.loadMessages();
      this.root.classList.remove('dp-offline');
    } catch (error) { this.showError(error); }
    finally { this.loading = false; }
  }

  renderRooms() {
    const query = this.find('.dp-search').value.toLocaleLowerCase();
    const list = this.find('.dp-rooms');
    list.replaceChildren();
    const rooms = this.rooms.filter(room => room.title.toLocaleLowerCase().includes(query));
    for (const room of rooms) {
      const row = element('button', 'dp-room-row' + (room.id === this.roomId ? ' dp-selected' : ''));
      row.type = 'button';
      row.append(avatar(room.members, room.kind === 'direct' ? this.user?.uid : ''));
      const body = element('span', 'dp-room-summary');
      body.append(element('strong', '', room.title));
      const last = room.lastMessage;
      body.append(element('span', '', last ? (last.image ? 'Картинка' + (last.text ? ': ' + last.text : '') : last.text)
        : room.telegram?.state === 'ready' ? 'Новая беседа' : 'Создание беседы'));
      row.append(body);
      if (room.unread) row.append(element('span', 'dp-unread'));
      row.addEventListener('click', () => this.selectRoom(room.id));
      list.append(row);
    }
    if (!rooms.length) list.append(element('p', 'dp-muted', query ? 'Беседы не найдены' : 'Пока нет бесед'));
  }

  async selectRoom(roomId) {
    if (this.roomId !== roomId) {
      this.revokeImages(); this.messages.clear(); this.version++;
      this.textarea.value = ''; this.pendingAttempt = null; this.clearImage();
    }
    this.roomId = roomId;
    this.root.classList.add('dp-has-room');
    this.messageList.replaceChildren(element('div', 'dp-empty', 'Загрузка…'));
    this.renderRooms(); this.renderHeader();
    try { await this.loadMessages(true); this.textarea.focus(); }
    catch (error) { this.showError(error); }
  }

  renderHeader() {
    const room = this.rooms.find(item => item.id === this.roomId);
    const heading = this.find('.dp-room-title');
    const nav = this.find('.dp-room-head nav');
    heading.replaceChildren(); nav.replaceChildren();
    const enabled = Boolean(room && room.telegram?.state === 'ready');
    this.textarea.disabled = this.sendButton.disabled = this.attachButton.disabled = !enabled;
    this.textarea.placeholder = room && !enabled ? 'Создание беседы' : 'Сообщение';
    if (!room) { heading.append(element('strong', '', this.roomId ? 'Беседа' : 'Личные сообщения')); return; }
    this.root.classList.add('dp-has-room');
    heading.append(avatar(room.members, room.kind === 'direct' ? this.user?.uid : ''), element('strong', '', room.title));
    if (!this.detached) nav.append(tool('message-circle', 'Отдельное окно беседы', () => {
      const child = new MessengerWindow({
        auth: this.auth, floating: true, detached: true, roomId: room.id, apiBase: this.apiBase,
        onClose: () => this.children.delete(child)
      });
      this.children.add(child); child.start();
    }));
    const telegram = room.telegram || { state: 'off' };
    const notice = this.notice;
    notice.classList.remove('dp-error');
    notice.replaceChildren();
    if (telegram.state === 'ready' && telegram.invite && /^https:\/\/t\.me\/\+[A-Za-z0-9_-]+$/.test(telegram.invite)) {
      const link = element('a', '', 'Вступить в Telegram-группу');
      link.href = telegram.invite; link.target = '_blank'; link.rel = 'noopener noreferrer';
      notice.append(link);
    } else notice.textContent = telegram.state === 'paused' ? 'Telegram: соединение приостановлено' : 'Создание беседы';
  }

  async loadMessages(initial = false, older = false) {
    if (!this.roomId || !this.user) return;
    const roomId = this.roomId, version = this.version;
    const keys = [...this.messages.keys()].sort();
    const suffix = older && keys.length ? '?before=' + encodeURIComponent(keys[0])
      : !initial && keys.length ? '?after=' + encodeURIComponent(keys[keys.length - 1]) : '';
    const result = await this.request('/rooms/' + roomId + '/messages' + suffix);
    if (this.closed || roomId !== this.roomId || version !== this.version) return;
    if (initial) this.messages.clear();
    if (initial || older) this.hasOlder = result.hasMore;
    const atBottom = this.messageList.scrollHeight - this.messageList.scrollTop - this.messageList.clientHeight < 80;
    const oldHeight = this.messageList.scrollHeight;
    for (const message of result.messages) this.messages.set(message.id, message);
    if (initial || older || result.messages.length) {
      this.renderMessages();
      if (older) this.messageList.scrollTop = this.messageList.scrollHeight - oldHeight;
      else if (initial || atBottom) this.messageList.scrollTop = this.messageList.scrollHeight;
    }
    if (result.hasMore && !older && !initial) this.roomsUpdated = 0;
    const last = [...this.messages.keys()].sort().pop();
    if (last && !document.hidden && (initial || atBottom) && this.lastRead !== last) {
      await this.request('/rooms/' + roomId + '/read', { method: 'POST', body: { messageId: last } });
      this.lastRead = last;
      const room = this.rooms.find(item => item.id === roomId);
      if (room) room.unread = false;
      this.renderRooms();
    }
  }

  renderMessages() {
    const fragment = document.createDocumentFragment();
    if (this.hasOlder) {
      const older = tool('chevron-up', 'Предыдущие сообщения', async () => {
        older.disabled = true;
        try { await this.loadMessages(false, true); }
        catch (error) { this.showError(error); older.disabled = false; }
      });
      older.classList.add('dp-older'); fragment.append(older);
    }
    const room = this.rooms.find(item => item.id === this.roomId);
    for (const message of [...this.messages.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (message.kind === 'telegram_invite') {
        const service = element('article', 'dp-service-message');
        service.dataset.messageId = message.id;
        service.append(element('strong', '', 'DepressivePasties Bot'), element('p', '', message.text));
        if (/^https:\/\/t\.me\/\+[A-Za-z0-9_-]+$/.test(message.invite || '')) {
          const link = element('a', '', 'Вступить в Telegram-группу');
          link.href = message.invite; link.target = '_blank'; link.rel = 'noopener noreferrer';
          service.append(link);
        }
        fragment.append(service); continue;
      }
      const mine = message.senderUid === this.user.uid;
      const profile = room?.members.find(member => member.uid === message.senderUid) || { name: 'Участник', color: '#888888' };
      const row = element('article', 'dp-message' + (mine ? ' dp-mine' : ''));
      row.dataset.messageId = message.id;
      row.append(element('strong', 'dp-author', profile.name));
      row.querySelector('.dp-author').style.color = /^#[0-9a-f]{6}$/i.test(profile.color) ? profile.color : '#888888';
      if (message.image) {
        const button = element('button', 'dp-message-image');
        button.type = 'button'; button.setAttribute('aria-label', 'Открыть картинку');
        const image = element('img');
        image.alt = 'Картинка от ' + profile.name;
        image.width = message.image.width; image.height = message.image.height;
        image.loading = 'lazy';
        button.append(image); row.append(button);
        this.loadImage(message.image.id).then(url => {
          if (this.closed || !image.isConnected) return;
          image.src = url;
          button.onclick = () => this.previewImage(url, image.alt);
        }).catch(error => { if (image.isConnected) { image.alt = 'Не удалось загрузить картинку'; this.showError(error); } });
      }
      if (message.text) row.append(element('p', 'dp-message-text', message.text));
      const time = element('time', 'dp-time', new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
      time.dateTime = new Date(message.createdAt).toISOString();
      if (mine && ['uncertain', 'failed', 'sending'].includes(message.telegramState)) {
        time.title = message.telegramState === 'sending' ? 'Доставка в Telegram не подтверждена' : 'В Telegram не доставлено; на сайте сохранено';
        time.append(' · Telegram: ?');
      }
      row.append(time); fragment.append(row);
    }
    if (!this.messages.size) fragment.append(element('div', 'dp-empty', room?.telegram?.state === 'ready' ? 'Пока нет сообщений' : 'Создание беседы'));
    this.messageList.replaceChildren(fragment);
  }

  async loadImage(imageId) {
    const key = this.roomId + '/' + imageId;
    if (!this.imageUrls.has(key)) {
      const roomId = this.roomId;
      const pending = this.request('/rooms/' + roomId + '/images/' + imageId, { binary: true }).then(blob => {
        const url = URL.createObjectURL(blob);
        if (this.closed || roomId !== this.roomId) { URL.revokeObjectURL(url); throw new Error('Беседа закрыта'); }
        return url;
      }).catch(error => { this.imageUrls.delete(key); throw error; });
      this.imageUrls.set(key, pending);
    }
    return this.imageUrls.get(key);
  }

  previewImage(url, alt) {
    const dialog = element('dialog', 'dp-image-dialog');
    const image = element('img'); image.src = url; image.alt = alt;
    dialog.append(tool('x', 'Закрыть', () => dialog.close()), image);
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog); dialog.showModal();
  }

  chooseImage(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) {
      this.showError(new Error('Выбери PNG, JPEG или WebP до 8 МБ.')); return;
    }
    this.clearImage(); this.file = file;
    const box = this.find('.dp-attachment'); box.hidden = false;
    this.draftUrl = URL.createObjectURL(file);
    const image = element('img'); image.src = this.draftUrl; image.alt = '';
    box.replaceChildren(image, element('span', '', file.name), tool('x', 'Убрать картинку', () => this.clearImage()));
  }

  clearImage() {
    if (this.draftUrl) URL.revokeObjectURL(this.draftUrl);
    this.draftUrl = null; this.file = null; this.fileInput.value = '';
    this.find('.dp-attachment').hidden = true;
    this.find('.dp-attachment').replaceChildren();
  }

  async send() {
    if (!this.roomId || this.sending || this.textarea.disabled || (!this.textarea.value.trim() && !this.file)) return;
    const text = this.textarea.value, file = this.file, roomId = this.roomId;
    const prior = this.pendingAttempt;
    const clientId = prior?.text === text && prior?.file === file && prior?.roomId === roomId
      ? prior.clientId : crypto.randomUUID();
    this.pendingAttempt = { text, file, roomId, clientId };
    this.sending = true; this.sendButton.disabled = true;
    try {
      let data;
      if (file) {
        const body = new FormData(); body.append('image', file); body.append('text', text); body.append('clientId', clientId);
        data = await this.request('/rooms/' + roomId + '/images', { method: 'POST', body });
      } else data = await this.request('/rooms/' + roomId + '/messages', { method: 'POST', body: { text, clientId } });
      if (this.roomId === roomId) {
        if (this.textarea.value === text) { this.textarea.value = ''; this.textarea.style.height = ''; }
        if (this.file === file) this.clearImage();
        this.messages.set(data.message.id, data.message);
        this.renderMessages(); this.messageList.scrollTop = this.messageList.scrollHeight;
        this.notice.classList.remove('dp-error');
      }
      this.pendingAttempt = null; this.roomsUpdated = 0;
      await this.refresh();
    } catch (error) { this.showError(error); }
    finally { this.sending = false; this.sendButton.disabled = this.textarea.disabled; }
  }

  async showCreate() {
    this.find('.dp-new-room').hidden = false;
    this.find('.dp-new-error').textContent = '';
    this.kind = 'direct'; this.selectedMembers.clear();
    this.root.querySelectorAll('[data-kind]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.kind === 'direct')));
    this.find('.dp-group-name').hidden = true;
    try { this.members = (await this.request('/members')).members; this.renderMemberChoices(); }
    catch (error) { this.find('.dp-new-error').textContent = error.message; }
  }

  renderMemberChoices() {
    const query = this.find('.dp-member-search').value.toLocaleLowerCase();
    const list = this.find('.dp-member-list'); list.replaceChildren();
    const members = this.members.filter(member => member.uid !== this.user?.uid && member.name.toLocaleLowerCase().includes(query));
    for (const member of members) {
      const label = element('label', 'dp-member-choice');
      const input = element('input'); input.type = this.kind === 'direct' ? 'radio' : 'checkbox'; input.name = 'dp-members';
      input.checked = this.selectedMembers.has(member.uid);
      input.addEventListener('change', () => {
        if (this.kind === 'direct') this.selectedMembers.clear();
        if (input.checked) this.selectedMembers.add(member.uid); else this.selectedMembers.delete(member.uid);
        this.renderMemberChoices();
      });
      label.append(avatar([member]), element('span', '', member.name), input); list.append(label);
    }
    if (!members.length) list.append(element('p', 'dp-muted', 'Участники не найдены'));
  }

  async createRoom() {
    const button = this.find('.dp-create'); button.disabled = true;
    try {
      if (!this.selectedMembers.size) throw new Error('Выбери участников');
      const data = await this.request('/rooms', { method: 'POST', body: {
        members: [...this.selectedMembers], kind: this.kind, title: this.find('.dp-group-name').value
      } });
      this.rooms = [data.room, ...this.rooms.filter(room => room.id !== data.room.id)];
      this.find('.dp-new-room').hidden = true;
      await this.selectRoom(data.room.id);
    } catch (error) { this.find('.dp-new-error').textContent = error.message; }
    finally { button.disabled = false; }
  }

  showError(error) {
    if (this.closed) return;
    this.root.classList.add('dp-offline');
    this.notice.replaceChildren(element('span', '', error.message));
    const retry = element('button', 'dp-text-button', 'Повторить');
    retry.type = 'button'; retry.onclick = () => { this.roomsUpdated = 0; this.refresh(); };
    this.notice.append(retry); this.notice.classList.add('dp-error');
  }

  makeDraggable() {
    const head = this.find('.dp-window-head');
    let drag;
    head.addEventListener('pointerdown', event => {
      if (event.target.closest('button,a') || event.button !== 0 || innerWidth < 640) return;
      const rect = this.root.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      this.root.style.transform = 'none'; this.root.style.margin = '0';
      this.root.style.left = rect.left + 'px'; this.root.style.top = rect.top + 'px';
      head.setPointerCapture(event.pointerId);
    });
    head.addEventListener('pointermove', event => {
      if (!drag) return;
      this.root.style.left = Math.max(0, Math.min(innerWidth - this.root.offsetWidth, event.clientX - drag.x)) + 'px';
      this.root.style.top = Math.max(0, Math.min(innerHeight - this.root.offsetHeight, event.clientY - drag.y)) + 'px';
    });
    const stop = () => { drag = null; };
    head.addEventListener('pointerup', stop); head.addEventListener('pointercancel', stop);
    head.addEventListener('lostpointercapture', stop);
  }

  revokeImages() {
    for (const value of this.imageUrls.values()) value.then(url => URL.revokeObjectURL(url)).catch(() => {});
    this.imageUrls.clear();
  }

  close() {
    this.closed = true; clearTimeout(this.timer);
    for (const request of this.requests) request.abort();
    for (const child of this.children) child.close();
    this.revokeImages(); this.clearImage();
    document.removeEventListener('visibilitychange', this.visibility);
    this.root.remove(); this.onClose?.();
  }
}

export function installMessenger({ auth, state }) {
  if (window.overlayComponent || window.isPartyMode) return;
  const holder = document.getElementById('toolsBar') || document.getElementById('mainHeader');
  if (!holder || holder.querySelector('[data-messenger-open]')) return;
  loadMessengerStyle();
  let view;
  const button = tool('message-circle', 'Личные сообщения', () => {
    if (!state.authed) return;
    if (view && !view.closed) { view.root.style.zIndex = String(++windowLevel); return; }
    view = new MessengerWindow({ auth, floating: true }); view.start();
  });
  button.dataset.messengerOpen = '1';
  button.hidden = !state.authed;
  window.addEventListener('cc_authenticated', () => { button.hidden = false; });
  holder.append(button);
  return () => { view?.close(); button.remove(); };
}
