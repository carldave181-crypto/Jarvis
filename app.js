/* =========================================================
   MARS JARVIS · Phase 1 foundation
   Vanilla JS · Google Identity Services · Drive API · Web Speech API
   No backend, no database, no framework.
   All persistent memory lives in Google Drive: jarvis_data.json
   ========================================================= */
(() => {
'use strict';

/* ================= CONFIG ================= */
const DRIVE_FILE_NAME = 'jarvis_data.json';
const DRIVE_SCOPE     = 'https://www.googleapis.com/auth/drive.file';
const CLIENT_ID_KEY   = 'mars_jarvis_client_id';   // config only (not user data)
const DEFAULT_CLIENT_ID = '';                      // or paste your Client ID here
const MAX_HISTORY     = 200;

/* ================= HELPERS ================= */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const nowISO = () => new Date().toISOString();
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const fmtTime = iso => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

function toast(msg, type = '') {
  const t = h('div', { class: 'toast ' + type }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4200);
}

/* ================= STATE ================= */
const blankData = () => ({
  notes: [],
  tasks: [],
  research: [],
  settings: { wakeWord: 'jarvis', voiceName: '', rate: 1, pitch: 1, autoListen: false, muted: false },
  conversations: []
});
let data = blankData();
const sync = { status: 'offline', fileId: null, user: null, saving: false, again: false, timer: null, lastSaved: null };
const ui = { view: 'home', editingNote: null, noteFilter: '' };

function normalize(d) {
  const b = blankData();
  d = d && typeof d === 'object' ? d : {};
  return {
    notes: Array.isArray(d.notes) ? d.notes : [],
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
    research: Array.isArray(d.research) ? d.research : [],
    conversations: Array.isArray(d.conversations) ? d.conversations : [],
    settings: { ...b.settings, ...(d.settings || {}) }
  };
}

/* ================= GOOGLE AUTH ================= */
const auth = { token: null, expires: 0, client: null, pending: null };
const getClientId = () => (localStorage.getItem(CLIENT_ID_KEY) || DEFAULT_CLIENT_ID).trim();

function initAuthClient() {
  const id = getClientId();
  if (!id) throw new Error('Add your Google OAuth Client ID in Settings first.');
  if (!(window.google && google.accounts && google.accounts.oauth2))
    throw new Error('Google sign-in library has not loaded yet. Check your connection and try again.');
  auth.client = google.accounts.oauth2.initTokenClient({
    client_id: id,
    scope: DRIVE_SCOPE,
    callback: r => {
      const p = auth.pending; auth.pending = null;
      if (!p) return;
      if (r.error) return p.rej(new Error(r.error_description || r.error));
      auth.token = r.access_token;
      auth.expires = Date.now() + ((r.expires_in || 3600) - 60) * 1000;
      p.res();
    },
    error_callback: e => {
      const p = auth.pending; auth.pending = null;
      if (p) p.rej(new Error(e.type === 'popup_closed' ? 'The sign-in window was closed.' : (e.message || e.type || 'Sign-in failed.')));
    }
  });
}

function requestToken(prompt = '') {
  return new Promise((res, rej) => {
    try { if (!auth.client) initAuthClient(); } catch (e) { return rej(e); }
    auth.pending = { res, rej };
    auth.client.requestAccessToken({ prompt });
  });
}

const signedIn = () => !!auth.token;

/* ================= DRIVE API ================= */
async function driveFetch(url, opts = {}, retry = true) {
  if (!auth.token || Date.now() > auth.expires) await requestToken('');
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + auth.token } });
  if (res.status === 401 && retry) { auth.token = null; return driveFetch(url, opts, false); }
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch (_) {}
    throw new Error(`Drive ${res.status}: ${msg}`);
  }
  return res;
}

const driveApi = {
  async user() {
    const r = await driveFetch('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)');
    return (await r.json()).user;
  },
  async find() {
    const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
    const ob = encodeURIComponent('modifiedTime desc');
    const r = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=${ob}&spaces=drive&fields=files(id,name)`);
    const j = await r.json();
    return j.files && j.files[0] ? j.files[0].id : null;
  },
  async create(obj) {
    const b = 'mars' + Date.now();
    const meta = { name: DRIVE_FILE_NAME, mimeType: 'application/json' };
    const body =
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${b}--`;
    const r = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body
    });
    return (await r.json()).id;
  },
  async read(id) {
    const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    return r.json();
  },
  async update(id, obj) {
    await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
    });
  }
};

/* ================= MEMORY SYSTEM ================= */
function setSync(status) {
  sync.status = status;
  const labels = { offline: 'Offline', saving: 'Saving…', synced: 'Synced', error: 'Sync error', loading: 'Loading…' };
  $('#syncText').textContent = labels[status] || status;
  $('#syncDot').className = 'sync-dot ' + status;
  $('#statSync').textContent = labels[status] || status;
}

function touch() { renderAll(); scheduleSave(); }

function scheduleSave() {
  if (!signedIn()) { setSync('offline'); return; }
  clearTimeout(sync.timer);
  sync.timer = setTimeout(saveMemory, 700);
}

/* saveMemory: write the whole data object to jarvis_data.json on Drive */
async function saveMemory() {
  if (!signedIn()) { toast('Connect Google Drive to save your memory.', 'warn'); return false; }
  if (sync.saving) { sync.again = true; return false; }
  sync.saving = true; setSync('saving');
  try {
    if (!sync.fileId) sync.fileId = await driveApi.create(data);
    else await driveApi.update(sync.fileId, data);
    sync.lastSaved = nowISO();
    setSync('synced');
    return true;
  } catch (e) {
    console.error(e); setSync('error'); toast('Save failed: ' + e.message, 'error');
    return false;
  } finally {
    sync.saving = false;
    if (sync.again) { sync.again = false; scheduleSave(); }
    renderMemoryMeta();
  }
}

/* loadMemory: find (or create) jarvis_data.json and load it; merges anything made before sign-in */
async function loadMemory() {
  setSync('loading');
  const local = data;
  sync.fileId = await driveApi.find();
  if (!sync.fileId) {
    sync.fileId = await driveApi.create(local);
    sync.lastSaved = nowISO();
    toast('Created jarvis_data.json in your Drive.');
  } else {
    const remote = normalize(await driveApi.read(sync.fileId));
    let added = 0;
    for (const col of ['notes', 'tasks', 'research', 'conversations']) {
      const have = new Set(remote[col].map(x => x.id));
      for (const it of local[col]) if (!have.has(it.id)) { remote[col].push(it); added++; }
    }
    data = remote;
    if (added) scheduleSave();
    toast('Memory loaded from Drive.');
  }
  setSync('synced');
  applyVoiceSettings();
  renderAll();
}

/* addMemory / editMemory / deleteMemory work on any collection: notes, tasks, research, conversations */
function addMemory(col, item) { data[col].push(item); touch(); return item; }
function editMemory(col, id, patch) {
  const it = data[col].find(x => x.id === id);
  if (!it) return null;
  Object.assign(it, patch, { updated: nowISO() });
  touch(); return it;
}
function deleteMemory(col, id) {
  const i = data[col].findIndex(x => x.id === id);
  if (i < 0) return false;
  data[col].splice(i, 1);
  touch(); return true;
}

/* ================= CONNECT / DISCONNECT ================= */
async function connectDrive() {
  try {
    if (location.protocol === 'file:') throw new Error('Serve this folder over http://localhost (see README). Google sign-in does not work from file://');
    await requestToken('');
    sync.user = await driveApi.user().catch(() => null);
    await loadMemory();
    renderAuth();
  } catch (e) {
    console.error(e); setSync(signedIn() ? 'error' : 'offline');
    toast(e.message, 'error'); renderAuth();
  }
}
function disconnectDrive() {
  if (auth.token && window.google) { try { google.accounts.oauth2.revoke(auth.token, () => {}); } catch (_) {} }
  auth.token = null; auth.expires = 0; sync.fileId = null; sync.user = null;
  data = blankData();
  setSync('offline'); renderAuth(); renderAll();
  toast('Disconnected. Local session cleared.');
}

/* ================= SPEECH SYNTHESIS ================= */
const synth = window.speechSynthesis;
const voice = { speaking: false, listening: false, want: false, awakeUntil: 0, ptt: false, rec: null };

function populateVoices() {
  if (!synth) return;
  const sel = $('#voiceSelect');
  const voices = synth.getVoices();
  sel.innerHTML = '';
  sel.append(h('option', { value: '' }, 'System default'));
  voices.forEach(v => sel.append(h('option', { value: v.name }, `${v.name} (${v.lang})`)));
  sel.value = data.settings.voiceName || '';
}

function speak(text) {
  if (!synth || data.settings.muted || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = synth.getVoices().find(x => x.name === data.settings.voiceName);
  if (v) u.voice = v;
  u.rate = Number(data.settings.rate) || 1;
  u.pitch = Number(data.settings.pitch) || 1;
  u.onstart = () => { voice.speaking = true; updateVoiceUI(); };
  const done = () => { setTimeout(() => { voice.speaking = false; updateVoiceUI(); }, 400); };
  u.onend = done; u.onerror = done;
  synth.speak(u);
}

/* ================= SPEECH RECOGNITION ================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function setupRecognition() {
  if (!SR) return;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';
  rec.onstart = () => { voice.listening = true; updateVoiceUI(); };
  rec.onresult = e => {
    if (voice.speaking) return;            // don't hear ourselves
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const t = r[0].transcript.trim();
      if (!r.isFinal) { $('#liveText').textContent = t; continue; }
      handleHeard(t);
    }
  };
  rec.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      voice.want = false; voice.ptt = false;
      toast('Microphone access was blocked. Allow it in your browser and try again.', 'error');
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      console.warn('Speech error:', e.error);
    }
  };
  rec.onend = () => {
    voice.listening = false; updateVoiceUI();
    if (voice.want || voice.ptt) setTimeout(startRec, 300);   // continuous listening: keep restarting
  };
  voice.rec = rec;
}

function startRec() { try { voice.rec && voice.rec.start(); } catch (_) { /* already running */ } }

function startListening() {
  if (!SR) return toast('Speech recognition is not supported in this browser. Use Chrome or Edge.', 'warn');
  voice.want = true; startRec(); updateVoiceUI();
}
function stopListening() {
  voice.want = false; voice.awakeUntil = 0;
  try { voice.rec && voice.rec.stop(); } catch (_) {}
  updateVoiceUI();
}

function handleHeard(text) {
  $('#liveText').textContent = '“' + text + '”';
  if (voice.pttActive) { voice.pttActive = false; runCommand(text, 'voice'); return; }

  const wake = (data.settings.wakeWord || 'jarvis').toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(wake);
  if (idx >= 0) {
    const cmd = text.slice(idx + wake.length).replace(/^[\s,.:;!?-]+/, '');
    if (cmd) runCommand(cmd, 'voice');
    else { voice.awakeUntil = Date.now() + 7000; updateVoiceUI(); speak('Yes?'); }
  } else if (Date.now() < voice.awakeUntil) {
    voice.awakeUntil = 0; updateVoiceUI();
    runCommand(text, 'voice');
  }
}

function updateVoiceUI() {
  const orb = $('#orb'), label = $('#orbLabel');
  let state = 'off', text = 'Voice offline';
  if (voice.ptt) { state = 'ptt'; text = 'Listening · push to talk'; }
  else if (voice.speaking) { state = 'speaking'; text = 'Speaking'; }
  else if (Date.now() < voice.awakeUntil) { state = 'awake'; text = 'Awake · say your command'; }
  else if (voice.want && voice.listening) { state = 'listening'; text = `Listening for “${data.settings.wakeWord}”`; }
  else if (voice.want) { state = 'listening'; text = 'Starting microphone…'; }
  orb.className = 'orb ' + state;
  label.textContent = text;
  const bl = $('#btnListen');
  bl.textContent = voice.want ? '■ Stop listening' : '● Start listening';
  bl.classList.toggle('on', voice.want);
  const bm = $('#btnMute');
  bm.textContent = data.settings.muted ? '🔇 Muted' : '🔊 Voice on';
  bm.classList.toggle('warn', !!data.settings.muted);
}
setInterval(() => { if (voice.awakeUntil && Date.now() > voice.awakeUntil) { voice.awakeUntil = 0; updateVoiceUI(); } }, 800);

/* ================= COMMAND ENGINE ================= */
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const PRIO_ORDER = { high: 0, medium: 1, low: 2 };

const sortedNotes = () => [...data.notes].sort((a, b) => (b.created || '').localeCompare(a.created || ''));
const sortedTasks = () => [...data.tasks].sort((a, b) =>
  (a.done - b.done) || (PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]) || (a.created || '').localeCompare(b.created || ''));

/* resolve "2", "two", "last", or a text fragment to an item in a displayed list */
function resolveTarget(list, ref, textOf) {
  ref = ref.trim().toLowerCase().replace(/^(number|no\.?|#)\s*/, '').replace(/^(the|my)\s+/, '');
  if (!list.length) return null;
  if (/^(last|latest|newest|recent)(\s+one)?$/.test(ref))
    return list.reduce((a, b) => ((b.created || '') > (a.created || '') ? b : a));
  const n = /^\d+$/.test(ref) ? parseInt(ref, 10) : NUM_WORDS[ref];
  if (n) return list[n - 1] || null;
  const words = ref.split(/\s+/).filter(Boolean);
  return list.find(it => textOf(it).toLowerCase().includes(ref)) ||
         list.find(it => words.every(w => textOf(it).toLowerCase().includes(w))) || null;
}
const noteText = n => (n.title || '') + ' ' + (n.body || '');
const taskText = t => t.text || '';

function parsePriority(s) {
  let prio = null;
  s = s.replace(/\b(?:with\s+)?(high|medium|low|urgent|critical|normal)[\s-]*priority\b/i, (_, p) => { prio = p.toLowerCase(); return ''; })
       .replace(/\bpriority\s*(?:is|of|:)?\s*(high|medium|low|urgent|critical|normal)\b/i, (_, p) => { prio = p.toLowerCase(); return ''; });
  if (prio === 'urgent' || prio === 'critical') prio = 'high';
  if (prio === 'normal') prio = 'medium';
  return { text: s.replace(/\s{2,}/g, ' ').replace(/[\s,]+$/, '').trim(), prio };
}

function go(view) {
  ui.view = view;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#viewTitle').textContent = { home: 'Home', memory: 'Memory', tasks: 'Tasks', console: 'Voice Console', settings: 'Settings' }[view];
}

const syncNote = () => signedIn() ? '' : ' Drive is not connected yet, so it only lives in this session.';

/* ---- notes ---- */
function createNote(text) {
  const t = cap(text.trim());
  addMemory('notes', {
    id: uid(), title: t.length > 56 ? t.slice(0, 56).trim() + '…' : t,
    body: t.length > 56 ? t : '', created: nowISO(), updated: nowISO()
  });
  return 'I have saved your note.' + syncNote();
}
function listNotes() {
  go('memory');
  const ns = sortedNotes();
  if (!ns.length) return 'You have no notes yet.';
  const top = ns.slice(0, 3).map(n => n.title).join('; ');
  return `You have ${ns.length} note${ns.length > 1 ? 's' : ''}. Latest: ${top}.`;
}
function searchNotes(q) {
  go('memory'); ui.noteFilter = q; $('#noteSearch').value = q; renderNotes();
  const hits = sortedNotes().filter(n => noteText(n).toLowerCase().includes(q.toLowerCase()));
  if (!hits.length) return `I found no notes matching ${q}.`;
  return `I found ${hits.length} note${hits.length > 1 ? 's' : ''} matching ${q}: ${hits.slice(0, 3).map(n => n.title).join('; ')}.`;
}

/* ---- tasks ---- */
function createTask(raw) {
  const { text, prio } = parsePriority(raw);
  if (!text) return 'What should the task be?';
  addMemory('tasks', { id: uid(), text: cap(text), priority: prio || 'medium', done: false, created: nowISO(), updated: nowISO() });
  return `Task added with ${prio || 'medium'} priority.` + syncNote();
}

function processCommand(raw) {
  const s = raw.trim().replace(/[.!?]+$/, '');
  const l = s.toLowerCase();
  let m;

  /* navigation */
  if ((m = l.match(/^(?:go to|open|show me the|switch to|take me to)\s+(?:the\s+)?(home|memory|notes|tasks?|voice|console|settings?)(?:\s+(?:page|section|screen|tab))?$/))) {
    const v = { home: 'home', memory: 'memory', notes: 'memory', task: 'tasks', tasks: 'tasks', voice: 'console', console: 'console', setting: 'settings', settings: 'settings' }[m[1]];
    go(v); return `Opening ${v === 'console' ? 'the voice console' : v}.`;
  }

  /* notes */
  if ((m = s.match(/^(?:save|add|create|take|make|new|write)\s+(?:a\s+|new\s+)?note(?:\s+(?:that|saying|about|to|:))?\s+(.+)$/i)) ||
      (m = s.match(/^note(?:\s+(?:that|down))?\s+(.+)$/i)) ||
      (m = s.match(/^remember\s+(?:that\s+)?(.+)$/i))) return createNote(m[1]);

  if ((m = s.match(/^(?:search|find|look up|look for)\s+(?:my\s+)?notes?\s+(?:for|about|on|with)?\s*(.+)$/i))) return searchNotes(m[1]);

  if (/^(?:show|list|read|open|display)\s+(?:me\s+)?(?:all\s+)?(?:my\s+|the\s+)?notes?$/.test(l) || l === 'what are my notes') return listNotes();

  if ((m = s.match(/^(?:edit|update|change|rewrite)\s+note\s+(.+?)\s+(?:to|so it says|saying)\s+(.+)$/i))) {
    const n = resolveTarget(sortedNotes(), m[1], noteText);
    if (!n) return `I couldn't find a note matching ${m[1]}.`;
    const t = cap(m[2].trim());
    editMemory('notes', n.id, { title: t.length > 56 ? t.slice(0, 56).trim() + '…' : t, body: t.length > 56 ? t : '' });
    return 'Note updated.';
  }

  if ((m = s.match(/^(?:delete|remove|erase|trash)\s+(?:the\s+)?note\s+(.+)$/i))) {
    const n = resolveTarget(sortedNotes(), m[1], noteText);
    if (!n) return `I couldn't find a note matching ${m[1]}.`;
    deleteMemory('notes', n.id); return `Deleted the note: ${n.title}.`;
  }

  /* tasks */
  if ((m = s.match(/^(?:add|create|new|make)\s+(?:a\s+|an\s+|new\s+)?(?:(?:high|medium|low|urgent|critical)[\s-]*priority\s+)?task(?:\s+(?:to|for|called|:))?\s*(.*)$/i))) {
    const prefix = s.match(/(high|medium|low|urgent|critical)[\s-]*priority\s+task/i);
    return createTask((prefix ? prefix[1] + ' priority ' : '') + m[1]);
  }
  if ((m = s.match(/^remind me to\s+(.+)$/i))) return createTask(m[1]);

  if ((m = s.match(/^(?:complete|finish|finished|check off|tick off)\s+(?:the\s+)?task\s+(.+)$/i)) ||
      (m = s.match(/^mark\s+(?:the\s+)?task\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)$/i)) ||
      (m = s.match(/^(?:task)\s+(.+?)\s+(?:is\s+)?(?:done|complete|completed)$/i))) {
    const t = resolveTarget(sortedTasks(), m[1], taskText);
    if (!t) return `I couldn't find a task matching ${m[1]}.`;
    editMemory('tasks', t.id, { done: true, completed: nowISO() });
    return `Marked complete: ${t.text}.`;
  }

  if ((m = s.match(/^(?:delete|remove|cancel)\s+(?:the\s+)?task\s+(.+)$/i))) {
    const t = resolveTarget(sortedTasks(), m[1], taskText);
    if (!t) return `I couldn't find a task matching ${m[1]}.`;
    deleteMemory('tasks', t.id); return `Deleted the task: ${t.text}.`;
  }

  if ((m = s.match(/^(?:set|change|make|update)\s+(?:the\s+)?(?:priority\s+of\s+)?task\s+(.+?)\s+(?:priority\s+)?(?:to|as)?\s*(high|medium|low|urgent|critical)(?:\s+priority)?$/i)) ||
      (m = s.match(/^(?:set|change|make|update)\s+(?:the\s+)?priority\s+of\s+task\s+(.+?)\s+to\s+(high|medium|low|urgent|critical)$/i)) ||
      (m = s.match(/^prioriti[sz]e\s+task\s+(.+?)(?:\s+as\s+(high|medium|low))?$/i))) {
    const t = resolveTarget(sortedTasks(), m[1], taskText);
    if (!t) return `I couldn't find a task matching ${m[1]}.`;
    let p = (m[2] || 'high').toLowerCase(); if (p === 'urgent' || p === 'critical') p = 'high';
    editMemory('tasks', t.id, { priority: p });
    return `Task priority set to ${p}.`;
  }

  if (/^(?:show|list|read|display)\s+(?:me\s+)?(?:all\s+)?(?:my\s+|the\s+)?tasks?$/.test(l) || /^what(?:'s| is| are)\s+(?:on\s+)?my\s+(?:tasks?|to-?do(?: list)?)$/.test(l)) {
    go('tasks');
    const open = sortedTasks().filter(t => !t.done);
    if (!open.length) return 'You have no open tasks.';
    return `You have ${open.length} open task${open.length > 1 ? 's' : ''}. Top priority: ${open.slice(0, 3).map(t => t.text).join('; ')}.`;
  }

  /* utilities */
  if (/\bwhat(?:'s| is)?\s+the\s+time\b|^what time is it$|^time$/.test(l)) return 'It is ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.';
  if (/\b(?:what(?:'s| is)?\s+(?:the\s+)?(?:date|day)|today'?s date)\b/.test(l)) return 'Today is ' + new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + '.';
  if (/^(?:hello|hi|hey|good (?:morning|afternoon|evening))$/.test(l)) return 'Hello. All systems are online.';
  if (/^(?:thanks|thank you)$/.test(l)) return 'You are welcome.';
  if (/^(?:mute|be quiet|silence)$/.test(l)) { setMuted(true); return ''; }
  if (/^unmute$/.test(l)) { setMuted(false); return 'Voice restored.'; }
  if (/^(?:stop listening|go to sleep|sleep)$/.test(l)) { setTimeout(stopListening, 1500); return 'Going quiet. Say start listening on the console to wake me.'; }
  if (/^(?:help|what can you do)$/.test(l))
    return 'I can save, show, search, edit and delete notes, and add, complete, delete and prioritise tasks. Try: add note blockchain idea, or add high priority task call mom.';

  return "I didn't recognise that command. Say help to hear what I can do.";
}

function runCommand(text, source = 'text') {
  const input = text.trim();
  if (!input) return;
  let reply;
  try { reply = processCommand(input); }
  catch (e) { console.error(e); reply = 'Something went wrong running that command.'; }
  logConversation(input, reply, source);
  if (reply) { speak(reply); if (data.settings.muted) toast(reply); }
}

function logConversation(input, reply, source) {
  data.conversations.push({ id: uid(), created: nowISO(), source, input, response: reply });
  if (data.conversations.length > MAX_HISTORY) data.conversations.splice(0, data.conversations.length - MAX_HISTORY);
  touch();
}

function setMuted(v) {
  data.settings.muted = v;
  if (v && synth) synth.cancel();
  touch(); updateVoiceUI();
}

/* ================= RENDERING ================= */
function renderAll() {
  renderHome(); renderNotes(); renderTasks(); renderHistory(); renderMemoryMeta(); renderAuth(); renderSettings();
}

function renderHome() {
  const hr = new Date().getHours();
  $('#homeGreeting').textContent = (hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening') + '.';
  $('#homeDate').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  $('#statNotes').textContent = data.notes.length;
  $('#statTasks').textContent = data.tasks.filter(t => !t.done).length;
  $('#statCmds').textContent = data.conversations.length;
  const ul = $('#recentList'); ul.innerHTML = '';
  const recent = [...data.conversations].reverse().slice(0, 5);
  if (!recent.length) ul.append(h('li', { class: 'empty' }, 'Nothing yet. Say “Jarvis, add note…” or type a command above.'));
  recent.forEach(c => ul.append(h('li', {}, c.input, h('span', { class: 'meta' }, fmtTime(c.created) + ' · ' + c.response))));
}

function renderNotes() {
  const list = $('#notesList'); list.innerHTML = '';
  const q = ui.noteFilter.trim().toLowerCase();
  const all = sortedNotes();
  const shown = all.map((n, i) => ({ n, i: i + 1 })).filter(x => !q || noteText(x.n).toLowerCase().includes(q));
  $('#noteCount').textContent = `(${shown.length}${q ? ' of ' + all.length : ''})`;
  if (!shown.length) { list.append(h('div', { class: 'empty-state' }, q ? 'No notes match your search.' : 'No notes yet.')); return; }

  shown.forEach(({ n, i }) => {
    if (ui.editingNote === n.id) {
      const t = h('input', { value: n.title });
      const b = h('textarea', { rows: 4 }, n.body || '');
      list.append(h('div', { class: 'card' },
        h('span', { class: 'num' }, '#' + i), t, b,
        h('div', { class: 'acts' },
          h('button', { class: 'btn small primary', onclick: () => { editMemory('notes', n.id, { title: t.value.trim() || n.title, body: b.value }); ui.editingNote = null; renderNotes(); } }, 'Save'),
          h('button', { class: 'btn small', onclick: () => { ui.editingNote = null; renderNotes(); } }, 'Cancel'))));
    } else {
      list.append(h('div', { class: 'card' },
        h('span', { class: 'num' }, '#' + i),
        h('h4', {}, n.title),
        n.body ? h('p', {}, n.body) : null,
        h('div', { class: 'foot' }, h('span', {}, fmtTime(n.updated || n.created)),
          h('div', { class: 'acts' },
            h('button', { class: 'btn small', onclick: () => { ui.editingNote = n.id; renderNotes(); } }, 'Edit'),
            h('button', { class: 'btn small danger', onclick: () => deleteMemory('notes', n.id) }, 'Delete')))));
    }
  });
}

function renderTasks() {
  const ul = $('#tasksList'); ul.innerHTML = '';
  const ts = sortedTasks();
  $('#taskCount').textContent = `(${ts.filter(t => !t.done).length} open · ${ts.filter(t => t.done).length} done)`;
  if (!ts.length) { ul.append(h('div', { class: 'empty-state' }, 'No tasks. Add one above or say “Jarvis, add task …”.')); return; }
  ts.forEach((t, i) => {
    ul.append(h('li', { class: `task p-${t.priority} ${t.done ? 'done' : ''}` },
      h('span', { class: 'num' }, '#' + (i + 1)),
      h('button', { class: 'check', title: t.done ? 'Mark open' : 'Complete', onclick: () => editMemory('tasks', t.id, { done: !t.done, completed: t.done ? null : nowISO() }) }, t.done ? '✓' : ''),
      h('span', { class: 't-text' }, t.text),
      h('button', {
        class: 'badge ' + t.priority, title: 'Click to change priority',
        onclick: () => editMemory('tasks', t.id, { priority: { high: 'medium', medium: 'low', low: 'high' }[t.priority] })
      }, t.priority),
      h('button', { class: 'icon-btn', title: 'Delete', onclick: () => deleteMemory('tasks', t.id) }, '✕')));
  });
}

function renderHistory() {
  const ul = $('#historyList'); ul.innerHTML = '';
  const items = [...data.conversations].reverse();
  if (!items.length) { ul.append(h('li', { class: 'empty-state' }, 'No commands yet.')); return; }
  items.slice(0, 60).forEach(c => ul.append(h('li', { class: 'h-item' },
    h('div', { class: 'you' }, c.input),
    c.response ? h('div', { class: 'jarvis' }, c.response) : null,
    h('div', { class: 'meta' }, fmtTime(c.created) + ' · ' + c.source))));
}

function renderMemoryMeta() {
  const parts = [`${data.notes.length} notes`, `${data.tasks.length} tasks`, `${data.research.length} research`, `${data.conversations.length} conversations`];
  let s = parts.join(' · ');
  if (!signedIn()) s += ' · Not connected: data lives in this tab only.';
  else if (sync.lastSaved) s += ' · Last saved ' + fmtTime(sync.lastSaved);
  $('#memoryMeta').textContent = s;
  $('#dataInspector').textContent = JSON.stringify(data, null, 2);
}

function renderAuth() {
  const on = signedIn();
  const top = $('#topAuth');
  top.textContent = on ? ('● ' + (sync.user ? sync.user.emailAddress : 'Drive connected')) : 'Connect Drive';
  top.classList.toggle('on', on);
  $('#authInfo').textContent = on
    ? `Connected${sync.user ? ' as ' + sync.user.displayName + ' (' + sync.user.emailAddress + ')' : ''}. Memory file: ${DRIVE_FILE_NAME}`
    : 'Not connected.';
  $('#btnConnect').textContent = on ? 'Reconnect' : 'Connect Google Drive';
  $('#btnDisconnect').style.display = on ? '' : 'none';
}

function renderSettings() {
  const set = (id, v) => { const el = $(id); if (document.activeElement !== el && el.value !== String(v)) el.value = v; };
  set('#wakeWord', data.settings.wakeWord);
  set('#rate', data.settings.rate); set('#pitch', data.settings.pitch);
  $('#rateVal').textContent = Number(data.settings.rate).toFixed(2) + '×';
  $('#pitchVal').textContent = Number(data.settings.pitch).toFixed(2);
  $('#autoListen').checked = !!data.settings.autoListen;
  if (document.activeElement !== $('#voiceSelect')) $('#voiceSelect').value = data.settings.voiceName || '';
}

function applyVoiceSettings() { populateVoices(); updateVoiceUI(); }

/* ================= EVENT WIRING ================= */
function wire() {
  $$('.nav-btn').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
  $('#topAuth').addEventListener('click', () => signedIn() ? go('settings') : connectDrive());

  $('#homeForm').addEventListener('submit', e => { e.preventDefault(); runCommand($('#homeInput').value, 'text'); $('#homeInput').value = ''; });
  $('#cmdForm').addEventListener('submit', e => { e.preventDefault(); runCommand($('#cmdInput').value, 'text'); $('#cmdInput').value = ''; });

  $('#noteForm').addEventListener('submit', e => {
    e.preventDefault();
    const title = $('#noteTitle').value.trim(), body = $('#noteBody').value.trim();
    if (!title) return;
    addMemory('notes', { id: uid(), title, body, created: nowISO(), updated: nowISO() });
    $('#noteForm').reset(); toast('Note saved.' + syncNote());
  });
  $('#noteSearch').addEventListener('input', e => { ui.noteFilter = e.target.value; renderNotes(); });

  $('#taskForm').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('#taskText').value.trim(); if (!text) return;
    addMemory('tasks', { id: uid(), text: cap(text), priority: $('#taskPriority').value, done: false, created: nowISO(), updated: nowISO() });
    $('#taskText').value = '';
  });

  $('#btnListen').addEventListener('click', () => voice.want ? stopListening() : startListening());
  $('#btnMute').addEventListener('click', () => setMuted(!data.settings.muted));
  $('#btnClearHistory').addEventListener('click', () => { data.conversations = []; touch(); });

  /* push to talk: hold to speak a command (no wake word needed) */
  const ptt = $('#btnPtt');
  const pttDown = e => {
    e.preventDefault();
    if (!SR) return toast('Speech recognition is not supported in this browser.', 'warn');
    if (synth) synth.cancel();
    voice.ptt = true; voice.pttActive = true; ptt.classList.add('on');
    $('#liveText').textContent = 'Listening…';
    startRec(); updateVoiceUI();
  };
  const pttUp = () => {
    if (!voice.ptt) return;
    voice.ptt = false; ptt.classList.remove('on'); updateVoiceUI();
    if (!voice.want) { try { voice.rec.stop(); } catch (_) {} }
    setTimeout(() => { voice.pttActive = false; }, 4000);
  };
  ptt.addEventListener('pointerdown', pttDown);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => ptt.addEventListener(ev, pttUp));

  /* memory buttons */
  $('#btnSaveNow').addEventListener('click', async () => { if (await saveMemory()) toast('Memory saved to Drive.'); });
  $('#btnReload').addEventListener('click', async () => {
    if (!signedIn()) return toast('Connect Google Drive first.', 'warn');
    try { await loadMemory(); } catch (e) { toast(e.message, 'error'); setSync('error'); }
  });

  /* settings */
  $('#originText').textContent = location.origin === 'null' ? 'file:// (not supported)' : location.origin;
  $('#clientId').value = getClientId();
  $('#btnSaveClient').addEventListener('click', () => {
    localStorage.setItem(CLIENT_ID_KEY, $('#clientId').value.trim()); auth.client = null;
    toast('Client ID saved.');
  });
  $('#btnConnect').addEventListener('click', () => {
    localStorage.setItem(CLIENT_ID_KEY, $('#clientId').value.trim()); auth.client = null;
    connectDrive();
  });
  $('#btnDisconnect').addEventListener('click', disconnectDrive);

  $('#wakeWord').addEventListener('change', e => { data.settings.wakeWord = (e.target.value.trim() || 'jarvis').toLowerCase(); touch(); updateVoiceUI(); });
  $('#voiceSelect').addEventListener('change', e => { data.settings.voiceName = e.target.value; touch(); });
  $('#rate').addEventListener('input', e => { data.settings.rate = Number(e.target.value); $('#rateVal').textContent = data.settings.rate.toFixed(2) + '×'; });
  $('#rate').addEventListener('change', () => touch());
  $('#pitch').addEventListener('input', e => { data.settings.pitch = Number(e.target.value); $('#pitchVal').textContent = data.settings.pitch.toFixed(2); });
  $('#pitch').addEventListener('change', () => touch());
  $('#autoListen').addEventListener('change', e => { data.settings.autoListen = e.target.checked; touch(); });
  $('#btnTestVoice').addEventListener('click', () => { const was = data.settings.muted; data.settings.muted = false; speak('Mars Jarvis online. All systems nominal.'); data.settings.muted = was; });
  $('#btnExport').addEventListener('click', () => {
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: DRIVE_FILE_NAME });
    document.body.append(a); a.click(); a.remove();
  });

  if (synth) synth.onvoiceschanged = populateVoices;
}

/* ================= BOOT ================= */
function boot() {
  wire();
  populateVoices();
  setupRecognition();
  if (!SR) {
    $('#voiceSupport').textContent = 'Voice recognition is not supported in this browser. Use Chrome or Edge. Typed commands still work.';
    $('#btnListen').disabled = true; $('#btnPtt').disabled = true;
  } else {
    $('#voiceSupport').textContent = `Say “${data.settings.wakeWord}” then a command, e.g. “${data.settings.wakeWord}, add note blockchain idea”.`;
  }
  if (!synth) $('#btnMute').disabled = true;
  const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  tick(); setInterval(tick, 1000);
  setSync('offline'); renderAll(); updateVoiceUI();
  if (data.settings.autoListen && SR) startListening();
}
boot();

/* expose memory API for future phases (console / modules) */
window.MarsJarvis = { get data() { return data; }, saveMemory, loadMemory, addMemory, editMemory, deleteMemory, runCommand, go };
})();
