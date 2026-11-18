let active;
export function openEmojiEditor({ index, value, compress, save, reset }) {
  active?.close();
  const dialog = document.createElement('dialog');
  active = dialog;
  dialog.className = 'dp-emoji-editor';
  dialog.innerHTML = '<form><header><strong></strong><button type="button" data-close aria-label="Закрыть" title="Закрыть">×</button></header><div class="preview"></div><label>Эмодзи<input name="emoji" maxlength="80" autocomplete="off"></label><div class="sources"><button type="button" data-file>С устройства</button><button type="button" data-paste>Из буфера</button></div><input type="file" accept="image/*" hidden><p role="status" aria-live="polite"></p><footer><button type="button" data-reset>Сбросить</button><button type="submit">Сохранить</button></footer></form>';
  const style = document.createElement('style');
  style.textContent = '.dp-emoji-editor{box-sizing:border-box;width:min(360px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;border:1px solid #59616c;border-radius:8px;background:#171b21;color:#f5f5f5;padding:18px;font:16px system-ui;letter-spacing:0}.dp-emoji-editor::backdrop{background:#0008}.dp-emoji-editor form{display:grid;gap:16px;margin:0}.dp-emoji-editor header,.dp-emoji-editor footer,.dp-emoji-editor .sources{display:flex;gap:8px;align-items:center;justify-content:space-between}.dp-emoji-editor button{font:inherit;color:inherit;background:#303740;border:1px solid #59616c;border-radius:4px;padding:8px;cursor:pointer}.dp-emoji-editor button:disabled{opacity:.5}.dp-emoji-editor [type=submit]{background:#176b51}.dp-emoji-editor label{display:grid;gap:6px}.dp-emoji-editor input[name]{box-sizing:border-box;width:100%;min-width:0;font:inherit;padding:8px;color:inherit;background:#22272e;border:1px solid #59616c}.dp-emoji-editor .preview{height:96px;display:grid;place-items:center;font-size:48px}.dp-emoji-editor .preview img{width:96px;height:96px;object-fit:contain}.dp-emoji-editor p{margin:0;font-size:14px;color:#ffc1b9;overflow-wrap:anywhere}.dp-emoji-editor [hidden]{display:none}';
  dialog.append(style);
  const q = selector => dialog.querySelector(selector);
  const status = q('[role=status]');
  const input = q('[name=emoji]');
  const preview = q('.preview');
  let selected = value || '', busy = false, generation = 0;
  q('strong').textContent = 'Слот ' + (index + 1);
  input.value = typeof selected === 'string' ? selected : '';
  function render() {
    preview.replaceChildren();
    if (selected?.type === 'png') {
      const img = document.createElement('img'); img.src = selected.src; img.alt = 'Предпросмотр'; preview.append(img);
    } else preview.textContent = selected || '';
  }
  function lock(state) { busy = state; dialog.querySelectorAll('button:not([data-close]),input').forEach(n => n.disabled = state); }
  async function pick(file) {
    if (busy || !file) return;
    if (!file.type.startsWith('image/')) { status.textContent = 'Нужна картинка.'; return; }
    if (file.size > 8 * 1024 * 1024) { status.textContent = 'Картинка должна быть меньше 8 МБ.'; return; }
    const current = ++generation;
    lock(true); status.textContent = '';
    try { const src = await compress(file, 96); if (!dialog.open || current !== generation) return; selected = { type:'png', src }; input.value = ''; render(); }
    catch { status.textContent = 'Не удалось открыть картинку.'; }
    finally { lock(false); }
  }
  input.addEventListener('input', () => { selected = input.value.trim(); render(); });
  q('[data-file]').onclick = () => q('[type=file]').click();
  q('[type=file]').onchange = event => { pick(event.target.files[0]); event.target.value = ''; };
  q('[data-paste]').onclick = async () => {
    if (busy) return;
    try {
      if (!navigator.clipboard?.read) throw Error();
      const items = await navigator.clipboard.read();
      const item = items.find(x => x.types.some(t => t.startsWith('image/')));
      if (!item) { status.textContent = 'В буфере нет картинки.'; return; }
      await pick(await item.getType(item.types.find(t => t.startsWith('image/'))));
    } catch { status.textContent = 'Нажми Ctrl+V в этом окне или выбери файл.'; input.focus(); }
  };
  dialog.addEventListener('paste', event => {
    const file = [...(event.clipboardData?.items || [])].find(x => x.kind === 'file' && x.type.startsWith('image/'))?.getAsFile();
    if (file) { event.preventDefault(); event.stopPropagation(); pick(file); }
  });
  dialog.addEventListener('dragover', e => e.preventDefault());
  dialog.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); pick(e.dataTransfer?.files[0]); });
  q('[data-close]').onclick = () => dialog.close();
  q('[data-reset]').hidden = !reset;
  async function commit(action) {
    if (busy) return;
    lock(true); status.textContent = '';
    try { await action(); dialog.close(); } catch { status.textContent = 'Не удалось сохранить. Попробуй ещё раз.'; lock(false); }
  }
  q('[data-reset]').onclick = () => commit(reset);
  q('form').onsubmit = e => { e.preventDefault(); commit(() => save(selected)); };
  dialog.addEventListener('close', () => { ++generation; dialog.remove(); if (active === dialog) active = null; }, { once:true });
  dialog.addEventListener('click', e => { if (e.target === dialog) { const r=dialog.getBoundingClientRect(); if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom) dialog.close(); } });
  document.body.append(dialog); render(); dialog.showModal(); input.focus();
}
