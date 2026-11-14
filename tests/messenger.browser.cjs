// Browser smoke tests use explicit HTTP fakes, never live accounts or Telegram groups.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.resolve(__dirname, '../../screenshots');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {})
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const people = [
    { uid: 'nastya', name: 'Настя', emoji: '🦀', color: '#e8a1ae' },
    { uid: 'denis', name: 'Денис', emoji: '🦊', color: '#e0b660' },
    { uid: 'salyose', name: 'Salyose', emoji: '🤖', color: '#53d5b0' }
  ];
  const invitation = { id: '000000000001', kind: 'telegram_invite', senderUid: '_system',
    text: 'Беседа создана. Можно вступить в Telegram-группу или продолжить здесь.',
    invite: 'https://t.me/+testInvitation', createdAt: Date.now() - 180000, telegramState: 'native' };
  const rooms = [{
    id: 'd_test', title: 'Денис', kind: 'direct', members: people.slice(0, 2), updatedAt: Date.now(),
    unread: true, telegram: { state: 'ready', invite: invitation.invite }
  }];
  const messages = { d_test: [invitation,
    { id: '000000000002', senderUid: 'denis', text: 'Привет! Теперь можно общаться и здесь, и в Telegram.',
      createdAt: Date.now()-100000, telegramState: 'native' },
    { id: '000000000003', senderUid: 'nastya', text: 'Да, наконец отдельная беседа. Давай вечером сыграем?',
      createdAt: Date.now()-50000, telegramState: 'sent' }
  ] };
  let counter = 3, failNext = false;
  const sentIds = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await context.route('https://messenger.test/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.startsWith('/api')) {
      assert.equal('Bearer fake-member-token', route.request().headers().authorization);
      const suffix = url.pathname.slice(4);
      if (suffix === '/me') return json(route, { user: people[0], telegramEnabled: true });
      if (suffix === '/members') return json(route, { members: people });
      if (suffix === '/rooms' && method === 'GET') {
        return json(route, { rooms: rooms.map(room => ({ ...room, lastMessage: messages[room.id]?.at(-1) || null })) });
      }
      if (suffix === '/rooms' && method === 'POST') {
        const data = route.request().postDataJSON();
        const room = { id: 'g_new', title: data.title || 'Новая группа', kind: data.kind,
          members: people.filter(person => person.uid === 'nastya' || data.members.includes(person.uid)),
          updatedAt: Date.now(), telegram: { state: 'queued' } };
        rooms.push(room); messages[room.id] = [];
        return json(route, { room }, 201);
      }
      const match = suffix.match(/^\/rooms\/([^/]+)\/(messages|images|read)(?:\/([^/]+))?$/);
      if (match) {
        const [, rid, action] = match;
        if (action === 'read') return json(route, { ok: true });
        if (action === 'images' && method === 'GET') return route.fulfill({ contentType: 'image/png', body: png });
        if (method === 'GET') {
          const after = url.searchParams.get('after');
          return json(route, { messages: (messages[rid] || []).filter(message => !after || message.id > after), hasMore: false });
        }
        const data = action === 'messages' ? route.request().postDataJSON() : {};
        if (data.clientId) sentIds.push(data.clientId);
        if (failNext) { failNext = false; return route.abort('failed'); }
        const message = { id: String(++counter).padStart(12, '0'), senderUid: 'nastya',
          text: data.text || '', createdAt: Date.now(), telegramState: 'queued',
          ...(action === 'images' ? { image: { id: 'image1', width: 120, height: 120 } } : {}) };
        messages[rid].push(message);
        return json(route, { message }, 201);
      }
      return json(route, { error: 'Not found' }, 404);
    }
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><script type="module">import {MessengerWindow} from "/messenger/messenger.js"; window.testMessenger=new MessengerWindow({auth:{currentUser:{getIdToken:async()=>"fake-member-token"}},apiBase:"https://messenger.test/api"});window.testMessenger.start();</script></body></html>' });
    }
    const filename = path.resolve(root, '.' + url.pathname);
    if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename)) return route.fulfill({ status: 404 });
    const extension = path.extname(filename);
    const type = { '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extension] || 'text/plain';
    return route.fulfill({ contentType: type, body: fs.readFileSync(filename) });
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto('https://messenger.test/');
    await page.getByRole('button', { name: 'Денис', exact: false }).click();
    await page.getByText('DepressivePasties Bot', { exact: true }).waitFor();
    assert.equal(await page.locator('.dp-messages article').first().locator('strong').textContent(), 'DepressivePasties Bot');
    await page.locator('textarea').fill('<img src=x onerror=alert(1)>');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.locator('.dp-message-text').getByText('<img src=x onerror=alert(1)>', { exact: true }).waitFor();
    assert.equal(await page.locator('.dp-message-text img').count(), 0);
    await page.getByRole('button', { name: 'Отдельное окно беседы', exact: true }).click();
    await page.locator('.dp-detached textarea:not([disabled])').waitFor();
    const head = page.locator('.dp-detached .dp-window-head');
    const box = await head.boundingBox();
    await page.mouse.move(box.x + 30, box.y + 20);
    await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 80); await page.mouse.up();
    assert.ok((await head.boundingBox()).x > box.x + 20);
    await page.locator('.dp-detached').getByRole('button', { name: 'Закрыть', exact: true }).click();
    assert.equal(await page.locator('.dp-detached').count(), 0);

    failNext = true;
    await page.locator('textarea').fill('Повтор после обрыва связи');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.getByText('Нет соединения с мессенджером.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.locator('.dp-message-text').getByText('Повтор после обрыва связи', { exact: true }).waitFor();
    assert.equal(sentIds.at(-1), sentIds.at(-2));

    await page.locator('input[type=file]').setInputFiles({ name: 'picture.png', mimeType: 'image/png', buffer: png });
    await page.locator('.dp-attachment:not([hidden])').waitFor();
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.locator('.dp-message-image img[src^="blob:"]').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.dp-message-image img')].every(image => image.complete && image.naturalWidth > 0));
    await page.getByRole('button', { name: 'Открыть картинку', exact: true }).click();
    await page.locator('dialog[open]').waitFor();
    await page.locator('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'messenger-desktop.png') });

    await page.getByRole('button', { name: 'Новая беседа', exact: true }).click();
    await page.getByRole('button', { name: 'Группа', exact: true }).click();
    await page.getByLabel('Название группы').fill('Вечерняя компания');
    await page.locator('.dp-member-choice').filter({ hasText: 'Денис' }).click();
    await page.locator('.dp-member-choice').filter({ hasText: 'Salyose' }).click();
    await page.getByRole('button', { name: 'Создать беседу', exact: true }).click();
    await page.waitForFunction(() => window.testMessenger.roomId === 'g_new');
    assert.ok(await page.locator('textarea').isDisabled());
    assert.equal(await page.getByRole('button', { name: 'Подключить Telegram' }).count(), 0);
    await page.screenshot({ path: path.join(output, 'messenger-creating.png') });
    const pending = rooms.find(room => room.id === 'g_new');
    pending.telegram = { state: 'ready', invite: invitation.invite };
    messages.g_new = [{ ...invitation, id: '000000000001' }];
    await page.evaluate(async () => {
      window.testMessenger.roomsUpdated = 0;
      while (window.testMessenger.loading) await new Promise(resolve => setTimeout(resolve, 10));
      await window.testMessenger.refresh();
    });
    assert.ok(await page.locator('textarea').isEnabled());
    assert.equal(await page.locator('.dp-messages article').first().locator('strong').textContent(), 'DepressivePasties Bot');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => window.testMessenger.selectRoom('d_test'));
    await page.screenshot({ path: path.join(output, 'messenger-mobile.png') });
    const overflow = await page.evaluate(() => {
      const root = document.querySelector('.dp-messenger').getBoundingClientRect();
      return root.left < 0 || root.right > innerWidth || document.documentElement.scrollWidth > innerWidth;
    });
    assert.equal(overflow, false);
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    await page.getByRole('button', { name: 'К беседам', exact: true }).click();
    await page.locator('.dp-sidebar').waitFor({ state: 'visible' });
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.evaluate(async html => {
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      for (const style of parsed.querySelectorAll('style')) document.head.prepend(style.cloneNode(true));
      const prior = window.testMessenger;
      prior.close();
      window.testMessenger = new prior.constructor({ auth: prior.auth, floating: true, apiBase: prior.apiBase });
      await window.testMessenger.start();
      await window.testMessenger.selectRoom('d_test');
    }, fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
    await page.locator('.dp-floating textarea:not([disabled])').waitFor();
    const floatingBox = await page.locator('.dp-floating').boundingBox();
    assert.ok(floatingBox.width >= 500 && floatingBox.height >= 350);
    assert.ok(floatingBox.x >= 0 && floatingBox.y >= 0);
    await page.screenshot({ path: path.join(output, 'messenger-floating.png') });
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    console.log('Messenger browser: desktop/mobile, creation lock, first invitation, safe text, retry ID, images, preview, detached windows, dragging and navigation passed.');
    console.log('Screenshots: ' + output);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
