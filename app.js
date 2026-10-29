(() => {
  'use strict';
  const STORAGE_KEY = 'little-board-v1';
  const TABLE = 'little_board_state';
  const DEFAULT_COLS = [
    { id: 'inbox', name: 'Inbox', items: [] },
    { id: 'next', name: 'Next', items: [] },
    { id: 'doing', name: 'Doing', items: [] },
    { id: 'done', name: 'Done', items: [] }
  ];
  const blank = () => ({ version: 1, columns: DEFAULT_COLS.map(c => ({ ...c, items: [] })) });
  const deepCopy = value => JSON.parse(JSON.stringify(value));
  const boardEl = document.getElementById('board');
  const capture = document.getElementById('captureInput');
  const dlg = document.getElementById('editDialog');
  const moveDlg = document.getElementById('moveDialog');
  const moveChoices = document.getElementById('moveChoices');
  const movePreview = document.getElementById('movePreview');
  const columnNav = document.getElementById('columnNav');
  const editForm = document.getElementById('editForm');
  const editText = document.getElementById('editText');
  const editColumn = document.getElementById('editColumn');
  const toastEl = document.getElementById('toast');
  const authScreen = document.getElementById('authScreen');
  const authForm = document.getElementById('authForm');
  const authMessage = document.getElementById('authMessage');
  const app = document.getElementById('app');
  const migration = document.getElementById('migration');
  const syncStatus = document.getElementById('syncStatus');
  const syncText = document.getElementById('syncText');

  let client = null;
  let user = null;
  let state = blank();
  let serverState = null;
  let revision = 0;
  let pendingOps = [];
  let syncing = false;
  let refreshNeeded = false;
  let socket = null;
  let loadGeneration = 0;
  let loadingUserId = null;
  let retryTimer = null;
  let editingId = null;
  let movingId = null;
  let pointerDrag = null;
  let toastTimer = null;
  let authMode = 'signin';
  const modalOpen = () => dlg.open || moveDlg.open;

  function updateThemeButton() {
    const light = document.documentElement.dataset.theme === 'light';
    const btn = document.getElementById('themeToggle');
    btn.textContent = light ? '☾' : '☀';
    btn.title = light ? 'Switch to dark mode' : 'Switch to light mode';
    btn.setAttribute('aria-label', btn.title);
    document.querySelector('meta[name="theme-color"]').content = light ? '#f8f9fb' : '#0e141d';
  }
  updateThemeButton();
  document.getElementById('themeToggle').addEventListener('click', () => {
    const light = document.documentElement.dataset.theme === 'light';
    document.documentElement.dataset.theme = light ? 'dark' : 'light';
    try { localStorage.setItem('little-board-theme', light ? 'dark' : 'light'); } catch (_) {}
    updateThemeButton();
  });
  const toolsMenu = document.getElementById('toolsMenu');
  document.addEventListener('pointerdown', event => {
    if (toolsMenu.open && !toolsMenu.contains(event.target)) toolsMenu.open = false;
  });
  toolsMenu.addEventListener('click', event => {
    if (event.target.closest('.tools-panel button')) toolsMenu.open = false;
  });

  function uid() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  function isValid(data) {
    if (!data || !Array.isArray(data.columns) || data.columns.length < 1 || data.columns.length > 12) return false;
    const columnIds = new Set(), cardIds = new Set();
    let cardCount = 0;
    for (const col of data.columns) {
      if (!col || typeof col.id !== 'string' || !col.id || typeof col.name !== 'string' || col.name.length > 45 || !Array.isArray(col.items) || columnIds.has(col.id)) return false;
      columnIds.add(col.id);
      for (const item of col.items) {
        if (!item || typeof item.id !== 'string' || !item.id || typeof item.text !== 'string' || item.text.length > 12000 || cardIds.has(item.id)) return false;
        cardIds.add(item.id);
        if (++cardCount > 15000) return false;
      }
    }
    return true;
  }
  function safeRead(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch (_) { return null; }
  }
  function safeWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (_) { toast('Device storage unavailable. Export a backup if notes are important.'); }
  }
  function safeRemove(key) { try { localStorage.removeItem(key); } catch (_) {} }
  function ownerKey(suffix) { return `little-board-${suffix}-${user.id}`; }
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3700);
  }
  function setStatus(mode, text) {
    syncStatus.dataset.mode = mode;
    syncText.textContent = text;
  }
  function findCard(id, source = state) {
    for (const col of source.columns) {
      const index = col.items.findIndex(item => item.id === id);
      if (index !== -1) return { col, index, item: col.items[index] };
    }
    return null;
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Small, replayable edits: a concurrent update on another device won't erase
  // unrelated notes. The revision on the database row makes each save atomic.
  function applyOperation(board, op) {
    if (op.kind === 'replace') {
      if (!isValid(op.data)) return false;
      board.columns = deepCopy(op.data.columns);
      return true;
    }
    if (op.kind === 'add') {
      const target = board.columns.find(c => c.id === op.colId) || board.columns[0];
      if (findCard(op.item.id, board)) return false;
      target.items.unshift(deepCopy(op.item));
      return true;
    }
    if (op.kind === 'edit') {
      const found = findCard(op.id, board);
      const target = board.columns.find(c => c.id === op.colId);
      if (!found || !target) return false;
      found.item.text = op.text;
      if (found.col !== target) {
        found.col.items.splice(found.index, 1);
        target.items.unshift(found.item);
      }
      return true;
    }
    if (op.kind === 'delete') {
      const found = findCard(op.id, board);
      if (!found) return false;
      found.col.items.splice(found.index, 1);
      return true;
    }
    if (op.kind === 'move') {
      const found = findCard(op.id, board);
      const target = board.columns.find(c => c.id === op.colId);
      if (!found || !target) return false;
      found.col.items.splice(found.index, 1);
      target.items.splice(Math.max(0, Math.min(op.index, target.items.length)), 0, found.item);
      return true;
    }
    if (op.kind === 'rename') {
      const col = board.columns.find(c => c.id === op.colId);
      if (!col) return false;
      col.name = op.name;
      return true;
    }
    if (op.kind === 'clear') {
      const col = board.columns.find(c => c.id === op.colId);
      if (!col) return false;
      const ids = new Set(op.ids);
      col.items = col.items.filter(item => !ids.has(item.id));
      return true;
    }
    if (op.kind === 'merge') {
      if (!isValid(op.data)) return false;
      const hadCards = board.columns.some(c => c.items.length);
      const seen = new Set(board.columns.flatMap(c => c.items.map(i => i.id)));
      for (const prior of op.data.columns) {
        const target = board.columns.find(c => c.id === prior.id) || board.columns[0];
        if (!hadCards && board.columns.some(c => c.id === prior.id)) target.name = prior.name;
        for (const item of prior.items) {
          if (!seen.has(item.id)) {
            target.items.push(deepCopy(item));
            seen.add(item.id);
          }
        }
      }
      return true;
    }
    return false;
  }
  function replay(base, ops) {
    const next = deepCopy(base);
    ops.forEach(op => applyOperation(next, op));
    return next;
  }
  function persist() {
    if (!user) return;
    safeWrite(ownerKey('pending'), pendingOps);
    safeWrite(ownerKey('cache'), state);
  }
  function mutate(op) {
    if (!user || !applyOperation(state, op)) return;
    pendingOps.push(op);
    persist();
    render();
    setStatus('saving', 'Saving…');
    if (!syncing) void flushChanges();
  }

  // Optimistic concurrency: only write if the cloud revision still matches.
  // On mismatch, pull the new board and replay our own unsent edits onto it.
  async function flushChanges() {
    if (syncing || !user || !serverState || !pendingOps.length) return;
    syncing = true;
    const ownerId = user.id;
    let failed = null;
    try {
      let clashes = 0;
      while (pendingOps.length && user?.id === ownerId) {
        if (!navigator.onLine) throw new Error('No internet connection');
        const count = pendingOps.length;
        const batch = pendingOps.slice(0, count);
        const proposed = replay(serverState, batch);
        const response = await client.from(TABLE)
          .update({ data: proposed, revision: revision + 1, updated_at: new Date().toISOString() })
          .eq('user_id', ownerId).eq('revision', revision)
          .select('revision');
        if (response.error) throw response.error;
        if (!response.data?.length) {
          if (++clashes > 8) throw new Error('Too many conflicting changes. Try again shortly.');
          await fetchRemote(ownerId, true);
          continue;
        }
        clashes = 0;
        serverState = proposed;
        revision = Number(response.data[0].revision);
        pendingOps.splice(0, count);
        state = replay(serverState, pendingOps);
        persist();
      }
    } catch (error) {
      failed = error;
      setStatus('offline', 'Not synced · retrying');
      console.warn('Little Board sync:', error);
    } finally {
      syncing = false;
      if (user?.id !== ownerId) return;
      if (failed) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { if (serverState) void flushChanges(); else void reloadBoard(); }, 9000);
      } else if (pendingOps.length) {
        void flushChanges();
      } else {
        // A revision conflict might have merged cards from a second device.
        // Paint the merged result, not just our earlier optimistic edit.
        if (!modalOpen() && !pointerDrag) render();
        else refreshNeeded = true;
        setStatus('synced', 'All changes saved');
        if (refreshNeeded) void refreshRemote();
      }
    }
  }

  async function fetchRemote(ownerId, updatingForConflict = false) {
    const response = await client.from(TABLE).select('data, revision').eq('user_id', ownerId).maybeSingle();
    if (response.error) throw response.error;
    if (!response.data) throw new Error('Board record could not be found.');
    if (!isValid(response.data.data)) throw new Error('Cloud data is not a valid Little Board.');
    if (user?.id !== ownerId) return;
    serverState = response.data.data;
    revision = Number(response.data.revision);
    state = replay(serverState, pendingOps);
    persist();
    if (!updatingForConflict && !modalOpen() && !pointerDrag) render();
    refreshNeeded = false;
  }
  async function refreshRemote() {
    if (!user || !serverState) return;
    if (syncing || pendingOps.length || modalOpen() || pointerDrag) {
      refreshNeeded = true;
      return;
    }
    try {
      await fetchRemote(user.id);
      setStatus('synced', 'All changes saved');
    } catch (error) {
      console.warn('Little Board refresh:', error);
      setStatus('offline', 'Connection interrupted');
    }
  }
  function subscribe(ownerId) {
    if (socket) { void client.removeChannel(socket); socket = null; }
    socket = client.channel(`little-board-${ownerId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: TABLE, filter: `user_id=eq.${ownerId}`
      }, () => { if (user?.id === ownerId) void refreshRemote(); })
      .subscribe();
  }
  async function reloadBoard() {
    if (!user || loadingUserId) return;
    const ownerId = user.id;
    if (!serverState) {
      // The initial load might have failed while offline. Try creating or
      // loading the board again, then reapply the locally queued edits.
      loadingUserId = ownerId;
      await loadBoard(ownerId, loadGeneration);
      return;
    }
    try {
      await fetchRemote(ownerId);
      if (pendingOps.length) void flushChanges();
      else setStatus('synced', 'All changes saved');
    } catch (error) {
      setStatus('offline', 'Connection interrupted');
      console.warn('Little Board reconnect:', error);
    }
  }
  async function loadBoard(ownerId, gen) {
    try {
      const response = await client.from(TABLE).select('data, revision').eq('user_id', ownerId).maybeSingle();
      if (response.error) throw response.error;
      let row = response.data;
      if (!row) {
        const create = await client.from(TABLE).insert({ user_id: ownerId, data: blank(), revision: 0 });
        if (create.error && create.error.code !== '23505') throw create.error;
        const again = await client.from(TABLE).select('data, revision').eq('user_id', ownerId).single();
        if (again.error) throw again.error;
        row = again.data;
      }
      if (!isValid(row.data)) throw new Error('The cloud board has an invalid data format.');
      if (gen !== loadGeneration) return;
      serverState = row.data;
      revision = Number(row.revision);
      pendingOps = readPending(ownerId);
      state = replay(serverState, pendingOps);
      persist();
      showBoard();
      subscribe(ownerId);
      setStatus('synced', 'All changes saved');
      if (pendingOps.length) void flushChanges();
    } catch (error) {
      if (gen !== loadGeneration) return;
      console.warn('Little Board load:', error);
      const cached = safeRead(`little-board-cache-${ownerId}`);
      pendingOps = readPending(ownerId);
      if (isValid(cached)) {
        state = cached;
        showBoard();
        setStatus('offline', 'Offline · will reconnect');
      } else {
        authScreen.hidden = false;
        app.hidden = true;
        document.getElementById('authLoading').textContent = 'Could not open the synced board.';
        showAuthMessage(`Cloud setup or connection error: ${error.message}\nCheck config.js and that setup.sql was run, then reload.`, true);
      }
    } finally {
      if (gen === loadGeneration) loadingUserId = null;
    }
  }
  function readPending(ownerId) {
    const ops = safeRead(`little-board-pending-${ownerId}`);
    return Array.isArray(ops) && ops.length < 10000 ? ops : [];
  }
  function showBoard() {
    authScreen.hidden = true;
    app.hidden = false;
    render();
    showMigrationOffer();
  }
  async function startSession(session) {
    const nextId = session?.user?.id || null;
    if (nextId && user?.id === nextId && (serverState || loadingUserId)) return;
    loadGeneration++;
    clearTimeout(retryTimer);
    if (socket && client) { void client.removeChannel(socket); socket = null; }
    if (!nextId) {
      user = null;
      loadingUserId = null;
      serverState = null;
      pendingOps = [];
      app.hidden = true;
      authScreen.hidden = false;
      document.getElementById('authLoading').hidden = true;
      authForm.hidden = false;
      showAuthMessage('');
      return;
    }
    user = session.user;
    serverState = null;
    state = blank();
    loadingUserId = nextId;
    authScreen.hidden = false;
    authForm.hidden = true;
    document.getElementById('authLoading').hidden = false;
    document.getElementById('authLoading').textContent = 'Opening your board…';
    showAuthMessage('');
    await loadBoard(nextId, loadGeneration);
  }
  function showAuthMessage(message, error = false) {
    authMessage.textContent = message;
    authMessage.classList.toggle('error', error);
  }
  function showMigrationOffer() {
    const old = safeRead(STORAGE_KEY);
    const hasOldCards = isValid(old) && old.columns.some(col => col.items.length);
    migration.hidden = !hasOldCards || !user || !!safeRead(ownerKey('migration-dismissed'));
  }

  function render() {
    const boardScroll = boardEl.scrollLeft;
    columnNav.replaceChildren();
    boardEl.replaceChildren();
    state.columns.forEach(col => {
      const tab = el('button', 'column-tab');
      tab.type = 'button';
      tab.dataset.id = col.id;
      tab.append(document.createTextNode(col.name), el('span', 'tab-count', String(col.items.length)));
      tab.addEventListener('click', () => scrollToColumn(col.id));
      columnNav.append(tab);
      const section = el('section', 'column');
      section.dataset.id = col.id;
      section.setAttribute('aria-label', `${col.name} column`);
      const header = el('header', 'col-header');
      const dot = el('span', 'col-dot');
      dot.setAttribute('aria-hidden', 'true');
      header.append(dot, el('h2', 'col-name', col.name), el('span', 'count', String(col.items.length)));
      const rename = el('button', 'rename', '⋯');
      rename.type = 'button';
      rename.title = `Rename ${col.name} column`;
      rename.setAttribute('aria-label', rename.title);
      rename.addEventListener('click', () => {
        const name = window.prompt('Column name:', col.name);
        if (name === null || !name.trim()) return;
        mutate({ kind: 'rename', colId: col.id, name: name.trim().slice(0,45) });
      });
      header.append(rename);
      const list = el('div', 'card-list');
      list.dataset.col = col.id;
      for (const item of col.items) {
        const card = el('article', 'card');
        card.dataset.id = item.id;
        const open = el('button', 'card-open', item.text);
        open.type = 'button';
        open.title = 'Click to edit';
        open.setAttribute('aria-label', `Edit note: ${item.text.slice(0,65)}`);
        open.addEventListener('click', () => openEditor(item.id));
        function makeHandle(side) {
          const handle = el('button', `card-handle card-handle-${side}`, '⠿');
          handle.type = 'button';
          handle.title = 'Tap to choose a column, or drag to move';
          handle.setAttribute('aria-label', `Move note: ${item.text.slice(0,60)}. Tap to choose a column, or use arrow keys.`);
          handle.setAttribute('aria-haspopup', 'dialog');
          handle.addEventListener('pointerdown', startPointerDrag);
          handle.addEventListener('keydown', event => handleArrows(event, item.id));
          return handle;
        }
        card.append(makeHandle('left'), open, makeHandle('right'));
        list.append(card);
      }
      if (!col.items.length) list.append(el('div', 'empty', 'Drop a note here'));
      section.append(header, list);
      boardEl.append(section);
    });
    boardEl.scrollLeft = boardScroll;
    updateActiveTab();
  }
  function updateActiveTab() {
    if (!state.columns.length) return;
    const boardLeft = boardEl.getBoundingClientRect().left;
    const columns = [...boardEl.querySelectorAll('.column')];
    let best = columns[0];
    for (const col of columns) {
      if (Math.abs(col.getBoundingClientRect().left - boardLeft) < Math.abs(best.getBoundingClientRect().left - boardLeft)) best = col;
    }
    for (const tab of columnNav.children) {
      if (tab.dataset.id === best?.dataset.id) tab.setAttribute('aria-current', 'true');
      else tab.removeAttribute('aria-current');
    }
  }
  boardEl.addEventListener('scroll', updateActiveTab, {passive: true});
  window.addEventListener('resize', updateActiveTab);
  function scrollToColumn(colId, instant = false) {
    const col = [...boardEl.querySelectorAll('.column')].find(c => c.dataset.id === colId);
    if (!col) return;
    const distance = col.getBoundingClientRect().left - boardEl.getBoundingClientRect().left;
    boardEl.scrollTo({left: boardEl.scrollLeft + distance, behavior: instant ? 'instant' : 'smooth'});
    if (instant) updateActiveTab();
  }
  function openMoveDialog(id) {
    const found = findCard(id);
    if (!found) return;
    movingId = id;
    movePreview.textContent = found.item.text.length > 250 ? `${found.item.text.slice(0, 250)}…` : found.item.text;
    moveChoices.replaceChildren();
    for (const col of state.columns) {
      const button = el('button', 'move-choice', col.name);
      button.type = 'button';
      button.disabled = col.id === found.col.id;
      if (button.disabled) button.textContent = `${col.name} ✓`;
      else button.addEventListener('click', () => {
        moveCard(id, state.columns.indexOf(col), 0);
        moveDlg.close();
        requestAnimationFrame(() => scrollToColumn(col.id, true));
      });
      moveChoices.append(button);
    }
    moveDlg.showModal();
  }
  document.getElementById('moveCancelBtn').addEventListener('click', () => moveDlg.close());
  document.getElementById('moveEditBtn').addEventListener('click', () => {
    const id = movingId;
    moveDlg.close();
    if (id) openEditor(id);
  });
  moveDlg.addEventListener('close', () => {
    movingId = null;
    if (refreshNeeded) void refreshRemote();
  });
  function openEditor(id) {
    const found = findCard(id);
    if (!found) return;
    editingId = id;
    editText.value = found.item.text;
    editColumn.replaceChildren();
    for (const col of state.columns) {
      const opt = document.createElement('option');
      opt.value = col.id; opt.textContent = col.name;
      editColumn.append(opt);
    }
    editColumn.value = found.col.id;
    dlg.showModal();
    editText.focus();
  }
  document.getElementById('captureForm').addEventListener('submit', event => {
    event.preventDefault();
    const text = capture.value.trim();
    if (!text || !user) { capture.focus(); return; }
    const item = { id: uid(), text, createdAt: Date.now() };
    mutate({kind:'add', colId:state.columns[0].id, item});
    capture.value = '';
    capture.focus();
  });
  capture.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      document.getElementById('captureForm').requestSubmit();
    }
  });
  editForm.addEventListener('submit', event => {
    event.preventDefault();
    const text = editText.value.trim();
    if (!text) { editText.focus(); return; }
    mutate({kind:'edit',id:editingId,text,colId:editColumn.value});
    dlg.close();
  });
  document.getElementById('cancelBtn').addEventListener('click', () => dlg.close());
  document.getElementById('deleteBtn').addEventListener('click', () => {
    const found = findCard(editingId);
    if (!found || !window.confirm('Delete this note?')) return;
    mutate({kind:'delete',id:editingId});
    dlg.close();
  });
  dlg.addEventListener('close', () => {
    editingId = null;
    if (refreshNeeded) void refreshRemote();
  });
  document.getElementById('clearDoneBtn').addEventListener('click', () => {
    const done = state.columns.find(col => col.id === 'done') || state.columns[state.columns.length - 1];
    if (!done.items.length) { toast('Nothing to clear.'); return; }
    if (!window.confirm(`Delete all ${done.items.length} notes in ${done.name}?`)) return;
    mutate({kind:'clear',colId:done.id,ids:done.items.map(i=>i.id)});
    toast('Done column cleared.');
  });
  document.getElementById('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state,null,2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `little-board-${new Date().toISOString().slice(0,10)}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
    toast('Backup exported.');
  });
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!isValid(data)) throw new Error('Not a Little Board backup');
      if (!window.confirm('REPLACE all notes on your synced board with this backup? This affects every device.')) return;
      mutate({kind:'replace',data});
      toast('Backup queued for sync.');
    } catch (_) { toast('Could not import. Choose a valid Little Board backup.'); }
    finally { event.target.value = ''; }
  });
  document.getElementById('migrateBtn').addEventListener('click', () => {
    const old = safeRead(STORAGE_KEY);
    if (!isValid(old) || !old.columns.some(c=>c.items.length)) return;
    const count = old.columns.reduce((n,c)=>n+c.items.length,0);
    if (!window.confirm(`Bring ${count} browser-only notes into your synced board? Existing cloud notes will be kept.`)) return;
    mutate({kind:'merge',data:old});
    safeWrite(ownerKey('migration-dismissed'),true);
    migration.hidden = true;
    toast('Old notes added to your synced board.');
  });
  document.getElementById('dismissMigrateBtn').addEventListener('click', () => {
    safeWrite(ownerKey('migration-dismissed'),true);
    migration.hidden = true;
  });
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (pendingOps.length && !window.confirm('There are unsynced changes. Sign out anyway? Changes remain on this device until you sign in here again.')) return;
    const result = await client.auth.signOut();
    if (result.error) toast(result.error.message);
  });
  function moveCard(id, columnIndex, itemIndex) {
    const target = state.columns[columnIndex];
    if (!findCard(id) || !target) return;
    mutate({kind:'move',id,colId:target.id,index:itemIndex});
  }
  function handleArrows(event, id) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMoveDialog(id);
      return;
    }
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const found = findCard(id);
    if (!found) return;
    const currentColumn = state.columns.indexOf(found.col);
    if (event.key === 'ArrowLeft' && currentColumn > 0) moveCard(id, currentColumn - 1, 0);
    if (event.key === 'ArrowRight' && currentColumn < state.columns.length - 1) moveCard(id, currentColumn + 1, 0);
    if (event.key === 'ArrowUp' && found.index > 0) moveCard(id, currentColumn, found.index - 1);
    if (event.key === 'ArrowDown' && found.index < found.col.items.length - 1) moveCard(id, currentColumn, found.index + 1);
    requestAnimationFrame(() => {
      const handle = [...document.querySelectorAll('.card')].find(c=>c.dataset.id === id)?.querySelector('.card-handle');
      handle?.focus();
    });
  }
  function startPointerDrag(event) {
    if (event.button !== 0 || pointerDrag) return;
    event.preventDefault();
    const source = event.currentTarget.closest('.card');
    const rect = source.getBoundingClientRect();
    pointerDrag = {
      id: source.dataset.id, pointerId: event.pointerId, source,
      startX: event.clientX, startY: event.clientY,
      offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
      width: rect.width, height: rect.height, ghost: null, marker: null,
      active: false
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) {}
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', cancelPointerDrag);
    window.addEventListener('keydown', onDragKeydown);
  }
  function onPointerMove(event) {
    const d = pointerDrag;
    if (!d || event.pointerId !== d.pointerId) return;
    if (!d.active) {
      if (Math.hypot(event.clientX - d.startX,event.clientY - d.startY) < 7) return;
      d.active = true;
      d.source.classList.add('drag-source');
      d.ghost = d.source.cloneNode(true);
      d.ghost.classList.remove('drag-source');
      d.ghost.classList.add('drag-ghost');
      d.ghost.style.width = `${d.width}px`;
      d.ghost.style.height = `${d.height}px`;
      document.body.append(d.ghost);
      d.marker = el('div','drop-placeholder');
      d.marker.style.flexBasis = `${Math.max(52,d.height)}px`;
      d.source.after(d.marker);
    }
    d.ghost.style.left = `${event.clientX - d.offsetX}px`;
    d.ghost.style.top = `${event.clientY - d.offsetY}px`;
    const over = document.elementFromPoint(event.clientX,event.clientY);
    const list = over?.closest('.card-list') || over?.closest('.column')?.querySelector('.card-list');
    if (list) {
      const cards = [...list.children].filter(child => child.classList.contains('card') && child !== d.source);
      const before = cards.find(card => event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
      if (before) list.insertBefore(d.marker,before);
      else list.append(d.marker);
    }
    const rect = boardEl.getBoundingClientRect();
    if (boardEl.scrollWidth > boardEl.clientWidth && event.clientY >= rect.top && event.clientY <= rect.bottom) {
      if (event.clientX < rect.left + 40) boardEl.scrollLeft -= 13;
      if (event.clientX > rect.right - 40) boardEl.scrollLeft += 13;
    }
  }
  function onPointerUp(event) {
    const d = pointerDrag;
    if (!d || event.pointerId !== d.pointerId) return;
    if (d.active && d.marker?.parentElement) {
      const list = d.marker.parentElement;
      const target = state.columns.findIndex(col => col.id === list.dataset.col);
      let index = 0;
      for (const child of list.children) {
        if (child === d.marker) break;
        if (child.classList.contains('card') && child !== d.source) index++;
      }
      const id = d.id;
      cleanupPointerDrag();
      if (target !== -1) moveCard(id,target,index);
    } else {
      const id = d.id;
      cleanupPointerDrag();
      openMoveDialog(id);
    }
  }
  function onDragKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); cleanupPointerDrag(); }
  }
  function cancelPointerDrag() { cleanupPointerDrag(); }
  function cleanupPointerDrag() {
    const d = pointerDrag;
    if (!d) return;
    d.source.classList.remove('drag-source');
    d.ghost?.remove(); d.marker?.remove();
    pointerDrag = null;
    window.removeEventListener('pointermove',onPointerMove);
    window.removeEventListener('pointerup',onPointerUp);
    window.removeEventListener('pointercancel',cancelPointerDrag);
    window.removeEventListener('keydown',onDragKeydown);
    if (refreshNeeded) void refreshRemote();
  }

  authForm.addEventListener('submit', async event => {
    event.preventDefault();
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    if (!client || !email || !password) return;
    const submit = document.getElementById('authSubmit');
    submit.disabled = true;
    showAuthMessage('');
    try {
      const result = authMode === 'signup'
        ? await client.auth.signUp({email,password,options:{emailRedirectTo:location.origin + location.pathname}})
        : await client.auth.signInWithPassword({email,password});
      if (result.error) throw result.error;
      if (authMode === 'signup' && !result.data.session) {
        showAuthMessage('Account requested. Check your email for the confirmation link, then return here to sign in.');
      }
    } catch (error) {
      showAuthMessage(error.message || 'Sign-in failed. Please try again.',true);
    } finally { submit.disabled = false; }
  });
  document.getElementById('authSwitch').addEventListener('click', () => {
    authMode = authMode === 'signin' ? 'signup' : 'signin';
    const creating = authMode === 'signup';
    document.getElementById('authTitle').textContent = creating ? 'Create account' : 'Sign in';
    document.getElementById('authSubmit').textContent = creating ? 'Create account' : 'Sign in';
    document.getElementById('authSwitch').textContent = creating ? 'Already have an account? Sign in' : 'Create an account instead';
    document.getElementById('authPassword').autocomplete = creating ? 'new-password' : 'current-password';
    showAuthMessage('');
  });
  window.addEventListener('online', () => { if (!user) return; if (serverState) void flushChanges(); else void reloadBoard(); void refreshRemote(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && user) {
      if (serverState) { if (pendingOps.length) void flushChanges(); else void refreshRemote(); }
      else void reloadBoard();
    }
  });
  setInterval(() => {
    if (!user || document.hidden) return;
    if (serverState) { if (pendingOps.length) void flushChanges(); else void refreshRemote(); }
    else void reloadBoard();
  }, 30000);

  // Public Supabase publishable/anon key is safe here ONLY with the SQL RLS policies.
  const cfg = window.LITTLE_BOARD_CONFIG;
  if (!cfg?.url || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(cfg.url) ||
      !cfg.key || cfg.key.includes('YOUR-') || !window.supabase?.createClient) {
    document.getElementById('authLoading').textContent = 'One-time setup needed';
    showAuthMessage('Run setup.sql in Supabase and put your Project URL and publishable/anon key into config.js. Then open the deployed website.',true);
  } else {
    client = window.supabase.createClient(cfg.url,cfg.key);
    client.auth.onAuthStateChange((event,session) => {
      if (event === 'TOKEN_REFRESHED') return;
      // Supabase recommends scheduling async work outside its auth callback.
      setTimeout(() => { void startSession(session); },0);
    });
  }
})();
