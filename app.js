/* =========================================================
   MARS JARVIS · Phase 3 (AI brain + auto sign-in)
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

function toast(msg, type = '', ms = 4200) {
  const t = h('div', { class: 'toast ' + type }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

/* ================= STATE ================= */
const blankData = () => ({
  notes: [],
  tasks: [],
  research: [],
  reminders: [],
  settings: { wakeWord: 'jarvis', voiceName: '', rate: 1, pitch: 1, autoListen: false, muted: false, home: null },
  conversations: []
});
let data = blankData();
const sync = { status: 'offline', fileId: null, user: null, saving: false, again: false, timer: null, lastSaved: null };
const ui = { view: 'home', editingNote: null, noteFilter: '', undo: null, warned: false, lastJoke: '', chat: [], lastAnswer: '', noBrain: false };
const ext = { pre: [], fallback: [], api: null };   // plugin hooks for future phases
window.MarsJarvisExt = ext;

function normalize(d) {
  const b = blankData();
  d = d && typeof d === 'object' ? d : {};
  return {
    notes: Array.isArray(d.notes) ? d.notes : [],
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
    research: Array.isArray(d.research) ? d.research : [],
    reminders: Array.isArray(d.reminders) ? d.reminders : [],
    conversations: Array.isArray(d.conversations) ? d.conversations : [],
    settings: { ...b.settings, ...(d.settings || {}) }
  };
}

/* ================= GOOGLE AUTH ================= */
const REMEMBER_KEY = 'mars_jarvis_remember';       // "this device was connected before" (config only)
const EMAIL_KEY    = 'mars_jarvis_email';          // hint so Google can sign in silently
const auth = { token: null, expires: 0, client: null, pending: null, promise: null, refreshTimer: null, needTap: false, tapArmed: false };
const getClientId = () => (localStorage.getItem(CLIENT_ID_KEY) || DEFAULT_CLIENT_ID).trim();
const remembered = () => !!localStorage.getItem(REMEMBER_KEY);

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
      auth.needTap = false;
      try { localStorage.setItem(REMEMBER_KEY, '1'); } catch (_) {}
      scheduleRefresh();
      p.res();
    },
    error_callback: e => {
      const p = auth.pending; auth.pending = null;
      if (p) p.rej(new Error(e.type === 'popup_closed' ? 'The sign-in window was closed.' : (e.message || e.type || 'Sign-in failed.')));
    }
  });
}

/* prompt '' = normal (may show a window), 'none' = silent attempt (no window if Google already trusts this device) */
function requestToken(prompt = '') {
  if (auth.promise) return auth.promise;
  auth.promise = new Promise((res, rej) => {
    try { if (!auth.client) initAuthClient(); } catch (e) { return rej(e); }
    auth.pending = { res, rej };
    const opts = { prompt };
    const hint = localStorage.getItem(EMAIL_KEY); if (hint) opts.hint = hint;
    if (prompt === 'none') {
      const mine = auth.pending;
      setTimeout(() => { if (auth.pending === mine) { auth.pending = null; rej(new Error('Silent sign-in did not finish.')); } }, 12000);
    }
    auth.client.requestAccessToken(opts);
  }).finally(() => { auth.promise = null; });
  return auth.promise;
}

async function silentRefresh() {
  try { await requestToken('none'); return true; } catch (_) { return false; }
}

function scheduleRefresh() {
  clearTimeout(auth.refreshTimer);
  const ms = Math.max(30000, auth.expires - Date.now() - 4 * 60000);
  auth.refreshTimer = setTimeout(async () => {
    if (!remembered()) return;
    if (!(await silentRefresh())) { auth.needTap = true; renderAuth(); armTapReconnect(); }
  }, ms);
}

/* if silent sign-in is not allowed, the very next tap anywhere reconnects (a tap is needed to open Google's window) */
function armTapReconnect() {
  if (auth.tapArmed) return;
  auth.tapArmed = true;
  const fn = e => {
    document.removeEventListener('click', fn, true);
    auth.tapArmed = false;
    if (e.target && e.target.closest && e.target.closest('#topAuth, #btnConnect, #btnDisconnect')) return;
    if (signedIn() && sync.fileId) {
      requestToken('').then(() => { auth.needTap = false; renderAuth(); toast('Drive reconnected.'); scheduleSave(); })
        .catch(err => { toast(err.message, 'error'); armTapReconnect(); });
    } else connectDrive();
  };
  document.addEventListener('click', fn, true);
}

function autoConnect() {
  if (!remembered() || !getClientId()) return;
  let tries = 0;
  const attempt = async () => {
    if (!(window.google && google.accounts && google.accounts.oauth2)) { if (++tries < 40) setTimeout(attempt, 500); return; }
    try {
      await requestToken('none');
      sync.user = await driveApi.user().catch(() => null);
      await loadMemory();
      renderAuth();
    } catch (e) {
      console.warn('Auto sign-in needs a tap:', e.message);
      auth.needTap = true; renderAuth(); armTapReconnect();
      toast('Tap anywhere to reconnect Google Drive.', 'warn');
    }
  };
  attempt();
}

const signedIn = () => !!auth.token;

/* ================= DRIVE API ================= */
async function driveFetch(url, opts = {}, retry = true) {
  if (!auth.token || Date.now() > auth.expires) { if (!(await silentRefresh())) await requestToken(''); }
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
    for (const col of ['notes', 'tasks', 'research', 'reminders', 'conversations']) {
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

/* addMemory / editMemory / deleteMemory work on any collection: notes, tasks, research, reminders, conversations */
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
    try { if (sync.user && sync.user.emailAddress) localStorage.setItem(EMAIL_KEY, sync.user.emailAddress); } catch (_) {}
    await loadMemory();
    renderAuth();
  } catch (e) {
    console.error(e); setSync(signedIn() ? 'error' : 'offline');
    toast(e.message, 'error'); renderAuth();
  }
}
function disconnectDrive() {
  if (auth.token && window.google) { try { google.accounts.oauth2.revoke(auth.token, () => {}); } catch (_) {} }
  auth.token = null; auth.expires = 0; auth.needTap = false; clearTimeout(auth.refreshTimer);
  try { localStorage.removeItem(REMEMBER_KEY); localStorage.removeItem(EMAIL_KEY); } catch (_) {}
  sync.fileId = null; sync.user = null;
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

/* ================= COMMAND ENGINE (Phase 2) ================= */
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const PRIO_ORDER = { high: 0, medium: 1, low: 2 };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const sortedNotes = () => [...data.notes].sort((a, b) => (b.created || '').localeCompare(a.created || ''));
const sortedTasks = () => [...data.tasks].sort((a, b) =>
  (a.done - b.done) || (PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]) || (a.created || '').localeCompare(b.created || ''));
const activeReminders = () => data.reminders.filter(r => !r.fired).sort((a, b) => a.due.localeCompare(b.due));

/* resolve "2", "two", "last", or a text fragment to an item in a displayed list */
function resolveTarget(list, ref, textOf) {
  ref = ref.trim().toLowerCase().replace(/^(?:the|my)\s+/, '').replace(/^(?:task|note|reminder|timer)\s+/, '').replace(/^(number|no\.?|#)\s*/, '').replace(/^the\s+/, '');
  if (!list.length) return null;
  if (/^(last|latest|newest|recent)(\s+one)?$/.test(ref))
    return list.reduce((a, b) => ((b.created || '') > (a.created || '') ? b : a));
  if (/^(oldest)(\s+one)?$/.test(ref)) return list.reduce((a, b) => ((b.created || '') < (a.created || '') ? b : a));
  const n = /^\d+$/.test(ref) ? parseInt(ref, 10) : NUM_WORDS[ref];
  if (n) return list[n - 1] || null;
  const words = ref.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return list.find(it => textOf(it).toLowerCase().includes(ref)) ||
         list.find(it => words.every(w => textOf(it).toLowerCase().includes(w))) || null;
}
const noteText = n => (n.title || '') + ' ' + (n.body || '');
const taskText = t => t.text || '';
const remText = r => r.text || '';

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
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ---------- date & time parsing ---------- */
const MONTH_SRC = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY_SRC = '(?:day after tomorrow|tomorrow|today|tonight|(?:(?:on|this|next|coming)\\s+)?(?:' + DAYS.join('|') + ')|next week|in\\s+\\d+\\s+(?:days?|weeks?)|' +
  MONTH_SRC + '\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MONTH_SRC + ')';
const DAY_RE = new RegExp('\\b' + DAY_SRC + '\\b', 'i');
const UNIT = '(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)';
const ONES = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

const dateStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const midnight = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function dayFromStr(s) {
  s = s.toLowerCase().trim();
  const today = midnight();
  let m;
  if (s === 'day after tomorrow') return addDays(today, 2);
  if (s === 'tomorrow') return addDays(today, 1);
  if (s === 'today' || s === 'tonight') return today;
  if (s === 'next week') return addDays(today, 7);
  if ((m = s.match(/^in\s+(\d+)\s+(day|week)s?$/))) return addDays(today, parseInt(m[1], 10) * (m[2] === 'week' ? 7 : 1));
  for (let i = 0; i < 7; i++) if (s.includes(DAYS[i])) {
    let diff = (i - today.getDay() + 7) % 7; if (diff === 0) diff = 7;
    return addDays(today, diff);
  }
  const mi = (str) => MONTHS.findIndex(x => str.toLowerCase().startsWith(x));
  let mon = -1, day = 0;
  if ((m = s.match(new RegExp('^(' + MONTH_SRC + ')\\.?\\s+(\\d{1,2})')))) { mon = mi(m[1]); day = +m[2]; }
  else if ((m = s.match(new RegExp('^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + MONTH_SRC + ')')))) { mon = mi(m[2]); day = +m[1]; }
  if (mon >= 0) {
    let d = new Date(today.getFullYear(), mon, day);
    if (d < today) d = new Date(today.getFullYear() + 1, mon, day);
    return d;
  }
  return null;
}

function normDur(s) {
  s = s.toLowerCase();
  s = s.replace(/\ba quarter of an hour\b/g, '15 minutes').replace(/\bhalf an hour\b/g, '30 minutes')
       .replace(/\ban hour and a half\b/g, '90 minutes').replace(/\bhalf a minute\b/g, '30 seconds')
       .replace(/\ba couple of (\w+)/g, '2 $1');
  s = s.replace(new RegExp('\\b(twenty|thirty|forty|fifty|sixty)[\\s-](one|two|three|four|five|six|seven|eight|nine)(?=\\s*' + UNIT + ')', 'g'), (_, a, b) => String(TENS[a] + ONES[b]));
  s = s.replace(new RegExp('\\b(' + Object.keys(ONES).concat(Object.keys(TENS)).join('|') + ')(?=\\s*' + UNIT + '\\b)', 'g'), (_, w) => String(ONES[w] || TENS[w]));
  s = s.replace(new RegExp('\\ban?(?=\\s+' + UNIT + '\\b)', 'g'), '1');
  s = s.replace(new RegExp('(\\d+)\\s+and a half\\s+(' + UNIT + ')', 'g'), (_, n, u) => (parseInt(n, 10) + 0.5) + ' ' + u);
  return s;
}
function parseDur(s) {
  s = normDur(s);
  const re = new RegExp('(\\d+(?:\\.\\d+)?)\\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\\b', 'g');
  let ms = 0, m, any = false;
  while ((m = re.exec(s))) {
    any = true;
    const n = parseFloat(m[1]), u = m[2][0], w = m[2].slice(0, 2);
    ms += n * (u === 's' ? 1000 : (u === 'm' && w !== 'mo') ? 60000 : u === 'h' ? 3600000 : u === 'd' ? 86400000 : 604800000);
  }
  return any ? Math.round(ms) : null;
}
function fmtDur(ms) {
  let s = Math.round(ms / 1000);
  const parts = [];
  const d = Math.floor(s / 86400); s -= d * 86400;
  const hh = Math.floor(s / 3600); s -= hh * 3600;
  const mm = Math.floor(s / 60); s -= mm * 60;
  if (d) parts.push(plural(d, 'day')); if (hh) parts.push(plural(hh, 'hour')); if (mm) parts.push(plural(mm, 'minute')); if (s) parts.push(plural(s, 'second'));
  return parts.join(' ') || '0 seconds';
}
const fmtClock = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtWhen(d) {
  const diff = Math.round((midnight(d) - midnight()) / 86400000);
  const day = diff === 0 ? 'at ' : diff === 1 ? 'tomorrow at ' : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) + ' at ';
  return day + fmtClock(d);
}
function fmtDue(ds) {
  const d = new Date(ds + 'T00:00:00');
  const diff = Math.round((d - midnight()) / 86400000);
  if (diff === 0) return 'today'; if (diff === 1) return 'tomorrow'; if (diff === -1) return 'yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function matchClock(t) {
  let m;
  if ((m = t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?=\W|$)/i)))
    return { h: +m[1], m: +(m[2] || 0), mer: m[3].toLowerCase() === 'p' ? 'pm' : 'am', str: m[0] };
  if ((m = t.match(/\b(?:at\s+)?(noon|midnight)\b/i)))
    return { h: m[1].toLowerCase() === 'noon' ? 12 : 0, m: 0, mer: 'x', str: m[0] };
  if ((m = t.match(/\b(?:at\s+)?(\d{1,2})\s*o'?clock\b/i))) return { h: +m[1], m: 0, mer: null, str: m[0] };
  if ((m = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?(?!\d)(?!\s*(?:minutes?|mins?|hours?|seconds?))/i))) return { h: +m[1], m: +(m[2] || 0), mer: null, str: m[0] };
  if ((m = t.match(/\b(\d{1,2}):(\d{2})\b/))) return { h: +m[1], m: +m[2], mer: null, str: m[0] };
  return null;
}

const tidyEdge = s => {
  s = s.replace(/\s{2,}/g, ' ').trim();
  let prev;
  do { prev = s; s = s.replace(/^(?:[,.]|\b(?:and|to|that|about|for|at|on|in|of)\b)\s*/i, '').replace(/\s*(?:[,.]|\b(?:at|on|in|by|and|for)\b)$/i, '').trim(); } while (s !== prev);
  return s;
};

/* find a time in free text ("in 10 minutes", "at 5pm", "tomorrow at 9", "friday evening"); returns {due, text} or null */
function findWhen(text) {
  const now = new Date();
  let t = normDur(text);
  const dm = t.match(new RegExp('\\b(?:in|after)\\s+(\\d+(?:\\.\\d+)?\\s*' + UNIT + '\\b(?:\\s*(?:,|and)?\\s*\\d+(?:\\.\\d+)?\\s*' + UNIT + '\\b)*)', 'i'));
  if (dm) {
    const ms = parseDur(dm[1]);
    if (ms) return { due: new Date(now.getTime() + ms), text: tidyEdge(t.replace(dm[0], ' ')) };
  }
  let day = null, dayWord = '';
  const dmatch = t.match(DAY_RE);
  if (dmatch) { day = dayFromStr(dmatch[0]); dayWord = dmatch[0].toLowerCase(); t = t.replace(dmatch[0], ' '); }
  const clock = matchClock(t);
  if (clock) t = t.replace(clock.str, ' ');
  let partHour = null;
  if (!clock) {
    const pm = t.match(/\b(?:in the |this |at )?(morning|afternoon|evening|night)\b/i);
    if (pm) { partHour = { morning: 9, afternoon: 15, evening: 18, night: 20 }[pm[1].toLowerCase()]; t = t.replace(pm[0], ' '); }
    else if (dayWord === 'tonight') partHour = 20;
  }
  if (!day && !clock && partHour == null) return null;
  if (day && !clock && partHour == null && dateStr(day) === dateStr(midnight()) && dayWord !== 'tonight') return null;

  const base = day ? new Date(day) : midnight();
  const at = (h, m) => { const d = new Date(base); d.setHours(h, m, 0, 0); return d; };
  let due;
  if (clock) {
    if (clock.mer === 'am' || clock.mer === 'pm' || clock.mer === 'x') {
      let h = clock.h % 12; if (clock.mer === 'pm') h += 12; if (clock.mer === 'x' && clock.h === 12) h = 12;
      due = at(h, clock.m);
    } else if (clock.h > 12 || clock.h === 0) due = at(clock.h, clock.m);
    else {
      const first = (clock.h >= 7 && clock.h <= 11) ? clock.h : (clock.h % 12) + 12;
      const second = first === clock.h ? (clock.h % 12) + 12 : clock.h % 12;
      due = at(first, clock.m);
      if (!day && due <= now) { const alt = at(second, clock.m); if (alt > now) due = alt; }
    }
  } else due = at(partHour != null ? partHour : 9, 0);
  if (!day && due <= now) due = addDays(due, 1);
  return { due, text: tidyEdge(t) };
}

/* pull "due friday" / "by tomorrow" out of a task */
function parseDue(s) {
  let m = s.match(new RegExp(',?\\s*\\b(?:due(?:\\s+(?:on|by|for))?|by|before|for)\\s+(' + DAY_SRC + ')\\s*$', 'i')) ||
          s.match(new RegExp(',?\\s*\\b(?:due(?:\\s+(?:on|by|for))?|by|before)\\s+(' + DAY_SRC + ')\\b', 'i')) ||
          s.match(new RegExp(',?\\s*\\b(tomorrow|tonight|today|next week|on\\s+(?:' + DAYS.join('|') + '))\\s*$', 'i'));
  if (!m) return { text: s, due: null };
  const d = dayFromStr(m[1]);
  if (!d) return { text: s, due: null };
  return { text: s.replace(m[0], ' ').replace(/\s{2,}/g, ' ').trim(), due: dateStr(d) };
}

/* ---------- notes ---------- */
const titleOf = t => t.length > 56 ? t.slice(0, 56).trim() + '…' : t;
function createNote(text) {
  const t = cap(text.trim());
  addMemory('notes', { id: uid(), title: titleOf(t), body: t.length > 56 ? t : '', created: nowISO(), updated: nowISO() });
  return 'I have saved your note.' + syncNote();
}
function listNotes() {
  go('memory');
  const ns = sortedNotes();
  if (!ns.length) return 'You have no notes yet.';
  const top = ns.slice(0, 3).map(n => n.title).join('; ');
  return `You have ${plural(ns.length, 'note')}. Latest: ${top}.`;
}
function searchNotes(q) {
  go('memory'); ui.noteFilter = q; $('#noteSearch').value = q; renderNotes();
  const hits = sortedNotes().filter(n => noteText(n).toLowerCase().includes(q.toLowerCase()));
  if (!hits.length) return `I found no notes matching ${q}.`;
  return `I found ${plural(hits.length, 'note')} matching ${q}: ${hits.slice(0, 3).map(n => n.title).join('; ')}.`;
}
const noteSpoken = n => (n.body && n.body !== n.title ? n.title + '. ' + n.body : n.title);

/* ---------- tasks ---------- */
function createTask(raw) {
  let { text, prio } = parsePriority(raw);
  const d = parseDue(text); text = d.text;
  text = text.replace(/^(?:to|that|about)\s+/i, '');
  if (!text) return 'What should the task be?';
  addMemory('tasks', { id: uid(), text: cap(text), priority: prio || 'medium', done: false, due: d.due || null, created: nowISO(), updated: nowISO() });
  return `Added task: ${cap(text)}${prio ? ', ' + prio + ' priority' : ''}${d.due ? ', due ' + fmtDue(d.due) : ''}.` + syncNote();
}
function tryTask(ref, open) {
  let list = sortedTasks(); if (open) list = list.filter(t => !t.done);
  return resolveTarget(list, ref, taskText);
}
const isOverdue = t => !t.done && t.due && t.due < dateStr(midnight());

/* ---------- undo ---------- */
function removeWithUndo(col, items, label) {
  items.forEach(it => deleteMemory(col, it.id));
  ui.undo = { col, items: items.map(x => ({ ...x })), label };
}

/* ---------- timers & reminders ---------- */
function ensureNotifyPermission() {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (_) {}
}
function addReminder(kind, text, due) {
  addMemory('reminders', { id: uid(), kind, text, due: due.toISOString(), fired: false, created: nowISO(), updated: nowISO() });
  ensureNotifyPermission();
  const first = !ui.warned; ui.warned = true;
  return first ? ' Keep Jarvis open so I can alert you.' : '';
}
function makeTimer(ms) {
  if (ms < 1000) return 'That timer is too short.';
  const label = fmtDur(ms);
  const extra = addReminder('timer', label + ' timer', new Date(Date.now() + ms));
  return `Timer set for ${label}.` + extra + syncNote();
}
function makeReminder(rest, needTime, dflt) {
  const w = findWhen(rest);
  if (!w) return needTime ? 'When should I remind you? Say something like: remind me in 30 minutes to call mom.' : null;
  const text = cap(w.text.replace(/^(?:to|that|about)\s+/i, '')) || dflt || 'Reminder';
  const extra = addReminder('reminder', text, w.due);
  if (text === 'Alarm') return `Alarm set for ${fmtWhen(w.due)}.` + extra + syncNote();
  return `Okay. I will remind you ${w.due - Date.now() < 3600000 ? 'in ' + fmtDur(Math.max(60000, Math.round((w.due - Date.now()) / 60000) * 60000)) : fmtWhen(w.due)}${text === 'Reminder' ? '' : ' to ' + text.charAt(0).toLowerCase() + text.slice(1)}.` + extra + syncNote();
}
function describeReminder(r) {
  const due = new Date(r.due);
  if (r.kind === 'timer') return `${r.text}, ${fmtDur(Math.max(0, due - Date.now()))} left`;
  return `${r.text} ${fmtWhen(due)}`;
}
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = beep.ctx || (beep.ctx = new AC()); if (ctx.state === 'suspended') ctx.resume();
    [0, 0.35, 0.7].forEach(off => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      const t0 = ctx.currentTime + off;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      o.start(t0); o.stop(t0 + 0.3);
    });
  } catch (_) {}
}
function fireReminder(r) {
  const missed = Date.now() - new Date(r.due).getTime() > 120000;
  const msg = r.kind === 'timer' ? `Your ${r.text} is done.` : (missed ? 'You missed a reminder: ' : 'Reminder: ') + r.text + '.';
  editMemory('reminders', r.id, { fired: true, firedAt: nowISO() });
  beep(); toast(msg, 'warn', 12000); speak(msg);
  try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch (_) {}
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      if (navigator.serviceWorker && navigator.serviceWorker.ready)
        navigator.serviceWorker.ready.then(reg => reg.showNotification('Mars Jarvis', { body: msg, icon: 'icon.svg', tag: r.id })).catch(() => new Notification('Mars Jarvis', { body: msg }));
      else new Notification('Mars Jarvis', { body: msg });
    }
  } catch (_) {}
  logConversation('(alert)', msg, 'system');
}
function checkReminders() {
  const now = Date.now();
  data.reminders.filter(r => !r.fired && new Date(r.due).getTime() <= now).forEach(fireReminder);
  const cutoff = now - 86400000;
  const before = data.reminders.length;
  data.reminders = data.reminders.filter(r => !r.fired || new Date(r.due).getTime() > cutoff);
  if (data.reminders.length !== before) scheduleSave();
}

/* ---------- web helpers ---------- */
function toastLink(url, label) {
  const a = h('a', { href: url, target: '_blank', rel: 'noopener', style: 'color:inherit;text-decoration:underline' }, label);
  const t = h('div', { class: 'toast warn' }, 'Tap to open: ', a);
  $('#toasts').append(t); setTimeout(() => t.remove(), 15000);
}
function openUrl(url, label) {
  let w = null;
  try { w = window.open(url, '_blank'); } catch (_) {}
  if (!w) toastLink(url, label || url);
}
const SITES = {
  youtube: 'https://www.youtube.com', 'you tube': 'https://www.youtube.com', google: 'https://www.google.com', maps: 'https://www.google.com/maps', 'google maps': 'https://www.google.com/maps',
  gmail: 'https://mail.google.com', email: 'https://mail.google.com', mail: 'https://mail.google.com', drive: 'https://drive.google.com', 'google drive': 'https://drive.google.com',
  calendar: 'https://calendar.google.com', 'google calendar': 'https://calendar.google.com', photos: 'https://photos.google.com', 'google photos': 'https://photos.google.com',
  github: 'https://github.com', wikipedia: 'https://www.wikipedia.org', facebook: 'https://www.facebook.com', messenger: 'https://www.messenger.com',
  instagram: 'https://www.instagram.com', twitter: 'https://x.com', x: 'https://x.com', tiktok: 'https://www.tiktok.com', spotify: 'https://open.spotify.com',
  netflix: 'https://www.netflix.com', amazon: 'https://www.amazon.com', whatsapp: 'https://web.whatsapp.com', news: 'https://news.google.com', translate: 'https://translate.google.com',
  'google translate': 'https://translate.google.com', chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai', reddit: 'https://www.reddit.com', linkedin: 'https://www.linkedin.com'
};
const enc = encodeURIComponent;
const googleSearch = q => { openUrl('https://www.google.com/search?q=' + enc(q), 'Google: ' + q); return `Searching Google for ${q}.`; };
const youtubeSearch = q => { openUrl('https://www.youtube.com/results?search_query=' + enc(q), 'YouTube: ' + q); return `Searching YouTube for ${q}.`; };
const mapsSearch = q => { openUrl('https://www.google.com/maps/search/?api=1&query=' + enc(q), 'Maps: ' + q); return `Showing ${q} on Maps.`; };
const mapsRoute = q => { openUrl('https://www.google.com/maps/dir/?api=1&destination=' + enc(q), 'Directions: ' + q); return `Getting directions to ${q}.`; };

/* ---------- math ---------- */
function evalMath(src) {
  let e = src.toLowerCase().replace(/^(?:what(?:'s| is)|calculate|compute|how much is|work out|solve|math|equals?)\s+/, '').replace(/\s*(?:equals?|is it)$/, '').replace(/[?=]+$/, '').trim();
  if (!e || !/\d/.test(e)) return null;
  e = e.replace(/(\d),(?=\d{3}\b)/g, '$1')
       .replace(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(\d+(?:\.\d+)?)/g, '($1/100*$2)')
       .replace(/square root of\s+(\d+(?:\.\d+)?)/g, 'Math.sqrt($1)')
       .replace(/(\d+(?:\.\d+)?)\s+squared/g, '($1**2)').replace(/(\d+(?:\.\d+)?)\s+cubed/g, '($1**3)')
       .replace(/to the power of|\^/g, '**')
       .replace(/\bplus\b|\band\b/g, '+').replace(/\bminus\b|\bless\b/g, '-')
       .replace(/\bmultiplied by\b|\btimes\b|\bmultiply by\b/g, '*').replace(/(\d)\s*x\s*(\d)/g, '$1*$2')
       .replace(/\bdivided by\b|\bover\b|\bdivide by\b/g, '/').replace(/\bmodulo\b|\bmod\b/g, '%');
  const probe = e.replace(/Math\.sqrt/g, '');
  if (!/^[\d+\-*/().%\s]+$/.test(probe) || !/[+\-*/%]|sqrt/.test(e)) return null;
  let v;
  try { v = Function('"use strict";return (' + e + ')')(); } catch (_) { return null; }
  if (typeof v !== 'number' || !isFinite(v)) return null;
  return Math.round(v * 1e6) / 1e6;
}

/* ---------- fun ---------- */
const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'I would tell you a UDP joke, but you might not get it.',
  'Why did the computer go to the doctor? It had a virus.',
  'There are only ten kinds of people: those who understand binary and those who do not.',
  'Why was the JavaScript developer sad? Because he did not know how to null his feelings.',
  'I asked the fridge for advice. It said, chill.',
  'Why did the scarecrow win an award? He was outstanding in his field.',
  'What do you call a fake noodle? An impasta.',
  'Why do bees have sticky hair? Because they use honeycombs.',
  'I told my computer I needed a break. Now it will not stop sending me Kit Kat ads.',
  'Why did the developer go broke? He used up all his cache.',
  'What is a robot is favorite snack? Microchips.'
];
const pick = a => a[Math.floor(Math.random() * a.length)];

/* ---------- weather ---------- */
const WCODE = { 0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers', 82: 'heavy rain showers',
  85: 'snow showers', 86: 'snow showers', 95: 'a thunderstorm', 96: 'a thunderstorm with hail', 99: 'a thunderstorm with hail' };

async function geocode(name) {
  const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=' + enc(name));
  const j = await r.json();
  if (!j.results || !j.results[0]) return null;
  const p = j.results[0];
  return { name: [p.name, p.admin1 || p.country].filter(Boolean).join(', '), lat: p.latitude, lon: p.longitude };
}
function getPosition() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(p => res({ name: 'your location', lat: p.coords.latitude, lon: p.coords.longitude }), rej, { timeout: 9000, maximumAge: 600000 });
  });
}
async function weatherReport(city) {
  let place = null;
  if (city) { place = await geocode(city); if (!place) return `I could not find a place called ${city}.`; }
  else if (data.settings.home) place = data.settings.home;
  else { try { place = await getPosition(); } catch (_) { return 'I could not get your location. Say, weather in, followed by a city, or set my city to something.'; } }
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`;
  const j = await (await fetch(u)).json();
  const c = j.current, d = j.daily;
  const f = x => Math.round(x * 9 / 5 + 32);
  const t = Math.round(c.temperature_2m);
  let s = `In ${place.name} it is ${t} degrees Celsius, ${f(c.temperature_2m)} Fahrenheit, with ${WCODE[c.weather_code] || 'unknown conditions'}.`;
  s += ` Feels like ${Math.round(c.apparent_temperature)}. Today's high is ${Math.round(d.temperature_2m_max[0])} and the low is ${Math.round(d.temperature_2m_min[0])}.`;
  if (d.precipitation_probability_max && d.precipitation_probability_max[0] != null) s += ` ${d.precipitation_probability_max[0]} percent chance of rain.`;
  return s;
}
async function setHome(city) {
  const p = await geocode(city);
  if (!p) return `I could not find a place called ${city}.`;
  data.settings.home = p; touch();
  return `Okay. Your city is ${p.name}.` + syncNote();
}

/* ================= AI BRAIN (Phase 3) =================
   Your API key is kept only in this device's localStorage. It is never written to Google Drive or GitHub. */
const BRAIN_KEY = 'mars_jarvis_brain';
const BRAIN_DEFAULTS = { provider: 'gemini', key: '', model: '', share: false };
const DEFAULT_MODEL = { gemini: 'gemini-flash-latest', anthropic: 'claude-haiku-5-5' };
const brainCfg = () => { try { return { ...BRAIN_DEFAULTS, ...JSON.parse(localStorage.getItem(BRAIN_KEY) || '{}') }; } catch (_) { return { ...BRAIN_DEFAULTS }; } };
const brainSave = c => localStorage.setItem(BRAIN_KEY, JSON.stringify(c));
const brainReady = () => !!brainCfg().key && !ui.noBrain;
const NO_KEY_MSG = 'I need an AI key first. Open Settings, and add a free Gemini key under AI Brain.';

function brainSystem() {
  const c = brainCfg();
  let sys = 'You are Mars Jarvis, a personal voice assistant inspired by Tony Stark\'s Jarvis, running inside the user\'s browser. ' +
    'Reply in plain spoken English: no markdown, no bullet symbols, no emojis. Keep it under 60 words unless the user asks for more. Be warm, sharp and a little witty. ' +
    'Current local date and time: ' + new Date().toString() + '. ' +
    'You can also run app commands. If the user clearly wants an app action, reply with exactly one line starting with CMD: followed by the command, using phrasings like ' +
    '"set a timer for 10 minutes", "remind me at 5 pm to call mom", "add task buy milk due friday", "add note something", "show tasks", "weather in Manila", "google something", "complete task 2". ' +
    'Never use CMD for deleting or cancelling anything. For everything else, just answer.';
  if (c.share) {
    const tasks = sortedTasks().filter(t => !t.done).slice(0, 10).map(t => `${t.text} (${t.priority}${t.due ? ', due ' + t.due : ''})`);
    const notes = sortedNotes().slice(0, 10).map(n => n.title);
    const rems = activeReminders().slice(0, 5).map(r => r.text);
    sys += ' The user allowed you to see their data. Open tasks: ' + (tasks.join('; ') || 'none') + '. Recent note titles: ' + (notes.join('; ') || 'none') + '. Upcoming reminders: ' + (rems.join('; ') || 'none') + '.';
  }
  return sys;
}

const BAD_CMD = /^(?:delete|remove|clear|erase|wipe|trash|cancel|disconnect|forget|undo)\b/i;

async function brainCall(c, messages) {
  const model = c.model || DEFAULT_MODEL[c.provider];
  let res, j;
  if (c.provider === 'anthropic') {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: 500, system: brainSystem(), messages: messages.map(m => ({ role: m.role, content: m.text })) })
    });
  } else {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(c.key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: brainSystem() }] },
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
        generationConfig: { maxOutputTokens: 2048 }
      })
    });
  }
  if (!res.ok) {
    const e = new Error('http ' + res.status); e.status = res.status;
    try { const b = await res.json(); e.detail = (b.error && (b.error.message || b.error.type)) || ''; } catch (_) {}
    throw e;
  }
  j = await res.json();
  if (c.provider === 'anthropic') return (j.content || []).map(p => p.text || '').join('').trim();
  const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
  return (parts || []).map(p => p.text || '').join('').trim();
}

async function askBrain(text) {
  const c = brainCfg();
  if (!c.key) return NO_KEY_MSG;
  ui.chat.push({ role: 'user', text });
  while (ui.chat.length > 12) ui.chat.shift();
  while (ui.chat.length && ui.chat[0].role !== 'user') ui.chat.shift();
  let out;
  try { out = await brainCall(c, ui.chat); }
  catch (e) {
    ui.chat.pop();
    console.warn('Brain error', e.status, e.detail);
    if (e.status === 429) return 'The AI is rate limited right now. Try again in a minute.';
    if (e.status === 400 || e.status === 401 || e.status === 403) return 'The AI rejected my key or model. Please check AI Brain in Settings.';
    if (e.status === 404) return 'That AI model name was not found. Clear the model box in Settings to use the default.';
    return 'I could not reach the AI. Check your connection and try again.';
  }
  out = out.replace(/[*_`#>]+/g, '').replace(/\s+\n/g, '\n').trim();
  if (!out) { ui.chat.pop(); return 'I have nothing to say to that.'; }
  const cm = out.match(/^CMD:\s*(.+)$/im);
  if (cm && BAD_CMD.test(cm[1].trim())) { ui.chat.pop(); return 'I will not delete or cancel things on my own. Tell me exactly what to remove, for example, delete note 2.'; }
  if (cm && !BAD_CMD.test(cm[1].trim())) {
    ui.noBrain = true;
    let r;
    try { r = await processCommand(cm[1].trim()); } catch (_) { r = 'I could not do that.'; }
    ui.noBrain = false;
    ui.chat.push({ role: 'assistant', text: 'Done: ' + cm[1].trim() });
    return r || 'Done.';
  }
  ui.chat.push({ role: 'assistant', text: out });
  ui.lastAnswer = out;
  return out;
}

function mountBrainSettings() {
  const grid = $('#view-settings .two-col'); if (!grid) return;
  const c = brainCfg();
  const prov = h('select', {}, h('option', { value: 'gemini' }, 'Google Gemini (free key)'), h('option', { value: 'anthropic' }, 'Anthropic Claude (paid key)'));
  prov.value = c.provider;
  const key = h('input', { type: 'password', placeholder: 'Paste your API key', autocomplete: 'off', spellcheck: 'false' }); key.value = c.key;
  const model = h('input', { placeholder: 'Model (empty = default)', autocomplete: 'off', spellcheck: 'false' }); model.value = c.model;
  const share = h('input', { type: 'checkbox' }); share.checked = c.share;
  const status = h('p', { class: 'muted small-t' });
  const refresh = () => { status.textContent = brainCfg().key ? 'Brain is ON. Ask me anything, or say “ask …”.' : 'Brain is OFF. Without a key I still run all normal commands.'; };
  const read = () => ({ provider: prov.value, key: key.value.trim(), model: model.value.trim(), share: share.checked });
  grid.append(h('div', { class: 'glass panel' },
    h('h3', {}, 'AI Brain'),
    h('p', { class: 'muted small-t' }, 'Lets Jarvis chat, explain things and understand loose phrasing. Free Gemini keys: aistudio.google.com/apikey. The key stays on this device only (never in Drive or GitHub). What you ask is sent to the provider you pick.'),
    h('label', {}, 'Provider'), prov,
    h('label', {}, 'API key'), key,
    h('label', {}, 'Model'), model,
    h('label', { class: 'check' }, share, ' Let the brain see my open tasks, note titles and reminders'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: () => { brainSave(read()); refresh(); toast('AI Brain saved.'); } }, 'Save'),
      h('button', { class: 'btn', onclick: async () => {
        brainSave(read()); refresh(); toast('Testing…');
        const saved = ui.chat; ui.chat = [];
        const r = await askBrain('Say hello in five words.'); ui.chat = saved;
        toast(r, '', 7000);
      } }, 'Test'),
      h('button', { class: 'btn danger', onclick: () => { brainSave({ ...read(), key: '' }); key.value = ''; refresh(); toast('Key removed from this device.'); } }, 'Remove key')),
    status));
  refresh();
}

/* explicit "ask the brain" phrasings */
const BRAIN_TRIGGER = /^(?:ask(?: ai| jarvis)?|ai|chat|explain|tell me about|summari[sz]e|define|describe|compare|brainstorm|translate|draft|write me|write an?|give me (?:an? )?(?:ideas?|tips?|advice|summary|suggestions?)|suggest|recommend|what do you think|should i|help me (?:with|decide|plan|write|understand)|teach me|how does|how do|why does|why do|why is|what should|what would|what if)\b/i;

/* ---------- the parser ---------- */
const FILLER = /^(?:(?:hey|ok|okay|please|jarvis|yo|hi|so|um|uh|just)[,\s]+|(?:can|could|would|will) you(?: please)?\s+|i want you to\s+|i(?:'d| would) like you to\s+|go ahead and\s+|i(?:'d| would) like to\s+|let's\s+|let me\s+)+/i;

function processCommand(raw) {
  let s = raw.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  s = s.replace(FILLER, '').replace(/[,\s]+(?:please|for me|thanks|thank you)$/i, '').trim();
  const l = s.toLowerCase();
  let m;
  if (!s) return 'Yes?';

  /* navigation */
  if ((m = l.match(/^(?:go to|open|show me the|switch to|take me to)\s+(?:the\s+)?(home|memory|notes|tasks?|voice|console|settings?)(?:\s+(?:page|section|screen|tab))?$/))) {
    const v = { home: 'home', memory: 'memory', notes: 'memory', task: 'tasks', tasks: 'tasks', voice: 'console', console: 'console', setting: 'settings', settings: 'settings' }[m[1]];
    go(v); return `Opening ${v === 'console' ? 'the voice console' : v}.`;
  }

  for (const f of ext.pre) { const r = f(s, l, raw); if (r !== undefined) return r; }

  /* undo */
  if (/^(?:undo|undo that|undo it|bring (?:it|them) back|restore (?:it|them|that))$/.test(l)) {
    const u = ui.undo; if (!u) return 'There is nothing to undo.';
    u.items.forEach(it => data[u.col].push(it)); ui.undo = null; touch();
    return 'Restored ' + u.label + '.';
  }

  /* ---- timers, alarms & reminders ---- */
  if ((m = l.match(/^how (?:much time|long)(?: is)?(?: left| remaining)?(?: on (?:the|my) timer)?$/)) || /^(?:time left|how much time is left)/.test(l)) {
    const t = activeReminders().filter(r => r.kind === 'timer')[0];
    return t ? `${fmtDur(Math.max(0, new Date(t.due) - Date.now()))} left on your ${t.text}.` : 'You have no running timers.';
  }
  if (/^(?:what|which|show|list|read|any|do i have|are there|tell me)\b/.test(l) && /\b(?:timers?|reminders?|alarms?)\b/.test(l) && !/\bremind me\b/.test(l)) {
    const wantT = /timer/.test(l), wantR = /reminder|alarm/.test(l);
    const list = activeReminders().filter(r => (wantT && r.kind === 'timer') || (wantR && r.kind !== 'timer') || (!wantT && !wantR));
    go('home');
    if (!list.length) return wantT ? 'You have no running timers.' : 'You have no upcoming reminders.';
    return `You have ${plural(list.length, wantT && !wantR ? 'timer' : 'item')}: ` + list.slice(0, 5).map(describeReminder).join('; ') + '.';
  }
  if ((m = l.match(/^(?:cancel|stop|delete|remove|clear|dismiss|turn off|kill)\s+(all\s+)?(?:the\s+|my\s+|that\s+)?(?:(?:running|active|upcoming)\s+)?(timer|reminder|alarm)s?(?:\s+(.+))?$/))) {
    const kindIsTimer = m[2] === 'timer';
    const list = activeReminders().filter(r => kindIsTimer ? r.kind === 'timer' : r.kind !== 'timer');
    if (!list.length) return kindIsTimer ? 'You have no running timers.' : 'You have no upcoming reminders.';
    let targets;
    if (m[1] || /^all$/.test((m[3] || '').trim())) targets = list;
    else if (m[3]) { const t = resolveTarget(list, m[3].replace(/^(?:number|no\.?)\s*/, ''), remText); targets = t ? [t] : []; if (!t) return `I couldn't find a ${m[2]} matching ${m[3]}.`; }
    else targets = [list[0]];
    targets.forEach(t => deleteMemory('reminders', t.id));
    return targets.length > 1 ? `Cancelled ${plural(targets.length, m[2])}.` : `Cancelled: ${targets[0].text}.`;
  }
  if (/\btimers?\b/.test(l) && !/\bremind/.test(l) && !/^help/.test(l)) {
    const ms = parseDur(l);
    return ms ? makeTimer(ms) : 'How long should the timer be? Say, set a timer for 10 minutes.';
  }
  if ((m = l.match(/^(?:set|create|make|add|start)\s+(?:me\s+)?(?:an?\s+)?(alarm|reminder)(?:\s+(.*))?$/))) {
    const r = makeReminder(m[2] || '', true, m[1] === 'alarm' ? 'Alarm' : ''); return r || 'When should I remind you?';
  }
  if ((m = s.match(/^wake me(?: up)?\s+(.+)$/i))) { const w = findWhen(m[1]); if (w) return makeReminder('wake up ' + m[1], true); }
  if ((m = s.match(/^remind me\s+(.+)$/i))) {
    const r = makeReminder(m[1], false); if (r) return r;
    return createTask(m[1]);
  }
  if ((m = s.match(/^(?:remember|don't forget|do not forget|don't let me forget)\s+to\s+(.+)$/i))) {
    const r = makeReminder(m[1], false); if (r) return r;
    if (/forget/i.test(s)) return createTask(m[1]);
  }

  /* ---- notes ---- */
  if (/^(?:save|note|remember|keep)\s+(?:that|this|it)(?:\s+(?:as a note|to my notes|in my notes))?$/.test(l)) {
    if (!ui.lastAnswer) return 'I have nothing to save yet.';
    createNote(ui.lastAnswer); return 'Saved that as a note.' + syncNote();
  }
  if (/^(?:new chat|forget (?:this|our) (?:chat|conversation)|clear (?:the )?chat|start over)$/.test(l)) { ui.chat = []; return 'Conversation cleared.'; }
  if ((m = s.match(/^(?:read|tell me|show me)\s+(?:me\s+)?(?:the\s+|my\s+)?(first|last|latest|newest|oldest|\d+|one|two|three|four|five)?\s*note(?:\s+(.+))?$/i)) && (m[1] || m[2])) {
    const ref = (m[1] || m[2]).trim();
    const list = sortedNotes();
    const n = /^(?:first|newest|latest)$/i.test(ref) ? list[0] : /^(?:last|oldest)$/i.test(ref) ? list[list.length - 1] : resolveTarget(list, ref, noteText);
    return n ? noteSpoken(n) + '.' : `I couldn't find a note matching ${ref}.`;
  }
  if (/^read\s+(?:me\s+)?(?:all\s+)?(?:my\s+|the\s+)?notes?(?:\s+(?:out loud|aloud|to me))?$/.test(l)) {
    go('memory');
    const ns = sortedNotes();
    if (!ns.length) return 'You have no notes yet.';
    return `You have ${plural(ns.length, 'note')}. ` + ns.slice(0, 5).map((n, i) => `Note ${i + 1}: ${noteSpoken(n)}.`).join(' ') + (ns.length > 5 ? ' That is the latest five.' : '');
  }

  if ((m = s.match(/^(?:rename|retitle)\s+note\s+(.+?)\s+(?:to|as)\s+(.+)$/i))) {
    const n = resolveTarget(sortedNotes(), m[1], noteText);
    if (!n) return `I couldn't find a note matching ${m[1]}.`;
    editMemory('notes', n.id, { title: titleOf(cap(m[2].trim())) });
    return `Note renamed to ${cap(m[2].trim())}.`;
  }
  if ((m = s.match(/^(?:edit|update|change|rewrite)\s+note\s+(.+?)\s+(?:to|so it says|saying)\s+(.+)$/i))) {
    const n = resolveTarget(sortedNotes(), m[1], noteText);
    if (!n) return `I couldn't find a note matching ${m[1]}.`;
    const t = cap(m[2].trim());
    editMemory('notes', n.id, { title: titleOf(t), body: t.length > 56 ? t : '' });
    return 'Note updated.';
  }
  if ((m = s.match(/^(?:delete|remove|erase|trash|get rid of)\s+(?:the\s+)?note\s+(.+)$/i))) {
    const n = resolveTarget(sortedNotes(), m[1], noteText);
    if (!n) return `I couldn't find a note matching ${m[1]}.`;
    removeWithUndo('notes', [n], 'your note'); return `Deleted the note: ${n.title}. Say undo to bring it back.`;
  }
  if ((m = s.match(/^(?:search|find|look up|look for)\s+(?:my\s+)?notes?\s+(?:for|about|on|with)?\s*(.+)$/i))) return searchNotes(m[1]);
  if (/^(?:show|list|display|open)\s+(?:me\s+)?(?:all\s+)?(?:my\s+|the\s+)?notes?$/.test(l) || /^what (?:are my notes|notes do i have)$/.test(l)) return listNotes();

  if ((m = s.match(/^(?:save|add|create|take|make|new|write|jot|put)\s+(?:down\s+)?(?:a\s+|new\s+|this\s+)?note(?:\s+(?:that|saying|about|to|of|:))?\s+(.+)$/i)) ||
      (m = s.match(/^(?:jot|write|put|scribble|type|note)\s+(?:this\s+)?down(?:\s+(?:that|:))?\s+(.+)$/i)) ||
      (m = s.match(/^note to self[:,]?\s+(.+)$/i)) ||
      (m = s.match(/^(?:save|add|put|store|keep)\s+(.+?)\s+(?:in|to|into|on)\s+(?:my\s+|the\s+)?notes?$/i)) ||
      (m = s.match(/^note(?:\s+(?:that|down))?\s+(.+)$/i)) ||
      (m = s.match(/^remember\s+(?:that\s+)?(.+)$/i))) return createNote(m[1]);

  /* ---- tasks ---- */
  if ((m = s.match(/^(?:set|change|move|update|make)\s+(?:the\s+)?(?:due date (?:of|for)\s+)?task\s+(.+?)\s+(?:to be\s+)?(?:due|due date)\s+(?:on\s+|by\s+|for\s+|to\s+)?(.+)$/i)) ||
      (m = s.match(/^(?:set|change|update)\s+(?:the\s+)?due date (?:of|for) task\s+(.+?)\s+(?:to|as|for)\s+(.+)$/i)) ||
      (m = s.match(/^task\s+(.+?)\s+is due\s+(?:on\s+|by\s+)?(.+)$/i))) {
    const t = tryTask(m[1]);
    if (!t) return `I couldn't find a task matching ${m[1]}.`;
    const d = dayFromStr(m[2].trim());
    if (!d) return `I didn't understand the date ${m[2]}. Try tomorrow, Friday, or March 5.`;
    editMemory('tasks', t.id, { due: dateStr(d) });
    return `Task due ${fmtDue(dateStr(d))}: ${t.text}.`;
  }

  if ((m = s.match(/^(?:add|create|new|make)\s+(?:a\s+|an\s+|new\s+)?(?:(?:high|medium|low|urgent|critical)[\s-]*priority\s+)?task(?:\s+(?:to|for|called|:))?\s*(.*)$/i))) {
    const prefix = s.match(/(high|medium|low|urgent|critical)[\s-]*priority\s+task/i);
    return createTask((prefix ? prefix[1] + ' priority ' : '') + m[1]);
  }

  if ((m = s.match(/^(?:complete|finish|finished|done with|check off|tick off|cross off)\s+(?:the\s+)?task\s+(.+)$/i)) ||
      (m = s.match(/^mark\s+(?:the\s+)?task\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)$/i)) ||
      (m = s.match(/^task\s+(.+?)\s+(?:is\s+)?(?:done|complete|completed|finished)$/i))) {
    const t = tryTask(m[1], false);
    if (!t) return `I couldn't find a task matching ${m[1]}.`;
    editMemory('tasks', t.id, { done: true, completed: nowISO() });
    return `Marked complete: ${t.text}.`;
  }
  if ((m = s.match(/^(?:reopen|uncomplete|un-complete|mark)\s+(?:the\s+)?task\s+(.+?)(?:\s+(?:as\s+)?(?:not done|open|incomplete|undone))?$/i)) && /^(?:reopen|uncomplete|un-complete)|(?:not done|open|incomplete|undone)$/i.test(s)) {
    const t = tryTask(m[1], false);
    if (!t) return `I couldn't find a task matching ${m[1]}.`;
    editMemory('tasks', t.id, { done: false, completed: null });
    return `Reopened: ${t.text}.`;
  }

  if ((m = s.match(/^(?:clear|delete|remove|get rid of|clean up|wipe)\s+(?:all\s+)?(?:the\s+|my\s+)?(?:completed|done|finished|checked)\s+tasks?$/i)) ||
      (m = s.match(/^(?:clear|delete|remove)\s+(?:all\s+)?tasks? that (?:are|i(?:'ve| have)) (?:done|completed|finished)$/i))) {
    const done = data.tasks.filter(t => t.done);
    if (!done.length) return 'You have no completed tasks to clear.';
    removeWithUndo('tasks', done, 'your tasks');
    return `Cleared ${plural(done.length, 'completed task')}. Say undo to bring them back.`;
  }

  if ((m = s.match(/^(?:rename|edit|update|change|reword)\s+task\s+(.+?)\s+to\s+(.+)$/i))) {
    const t = tryTask(m[1]);
    if (!t) return `I couldn't find a task matching ${m[1]}.`;
    editMemory('tasks', t.id, { text: cap(m[2].trim()) });
    return 'Task updated.';
  }

  if ((m = s.match(/^(?:delete|remove|cancel|scrap)\s+(?:the\s+)?task\s+(.+)$/i))) {
    const t = tryTask(m[1]);
    if (!t) return `I couldn't find a task matching ${m[1]}.`;
    removeWithUndo('tasks', [t], 'your task'); return `Deleted the task: ${t.text}. Say undo to bring it back.`;
  }

  if ((m = s.match(/^(?:set|change|make|update)\s+(?:the\s+)?(?:priority\s+of\s+)?task\s+(.+?)\s+(?:priority\s+)?(?:to|as)?\s*(high|medium|low|urgent|critical)(?:\s+priority)?$/i)) ||
      (m = s.match(/^(?:set|change|make|update)\s+(?:the\s+)?priority\s+of\s+task\s+(.+?)\s+to\s+(high|medium|low|urgent|critical)$/i)) ||
      (m = s.match(/^prioriti[sz]e\s+task\s+(.+?)(?:\s+as\s+(high|medium|low))?$/i))) {
    const t = tryTask(m[1]);
    if (!t) return `I couldn't find a task matching ${m[1]}.`;
    let p = (m[2] || 'high').toLowerCase(); if (p === 'urgent' || p === 'critical') p = 'high';
    editMemory('tasks', t.id, { priority: p });
    return `Task priority set to ${p}.`;
  }

  if ((m = l.match(/^(?:what(?:'s| is| are)?|show|list|any|which)\s*(?:me\s+)?(?:my\s+|the\s+|all\s+)?(?:tasks?\s+)?(overdue|late|due(?:\s+(today|tomorrow|this week))?)(?:\s+tasks?)?$/)) ||
      (m = l.match(/^(?:what(?:'s| is| are)?|show|list)\s+(?:me\s+)?(?:my\s+)?(overdue|late)\s+tasks?$/))) {
    go('tasks');
    const today = dateStr(midnight()), tmr = dateStr(addDays(midnight(), 1)), wk = dateStr(addDays(midnight(), 7));
    const scope = m[2] || (/overdue|late/.test(m[1]) ? 'overdue' : 'any');
    const open = sortedTasks().filter(t => !t.done && t.due);
    const hit = open.filter(t => scope === 'overdue' ? t.due < today : scope === 'today' ? t.due === today : scope === 'tomorrow' ? t.due === tmr : scope === 'this week' ? t.due <= wk : true);
    if (!hit.length) return scope === 'overdue' ? 'You have no overdue tasks.' : `You have nothing due${scope === 'any' ? ' yet' : ' ' + scope}.`;
    return `${plural(hit.length, 'task')} ${scope === 'overdue' ? 'overdue' : 'due'}: ` + hit.slice(0, 5).map(t => `${t.text}, ${fmtDue(t.due)}`).join('; ') + '.';
  }

  if (/^read\s+(?:me\s+)?(?:all\s+)?(?:my\s+|the\s+)?(?:tasks?|to-?do(?: list)?)(?:\s+(?:out loud|aloud|to me))?$/.test(l)) {
    go('tasks');
    const open = sortedTasks().filter(t => !t.done);
    if (!open.length) return 'You have no open tasks.';
    return `You have ${plural(open.length, 'open task')}. ` + open.slice(0, 8).map((t, i) => `${i + 1}: ${t.text}${t.due ? ', due ' + fmtDue(t.due) : ''}.`).join(' ');
  }
  if (/^(?:show|list|display)\s+(?:me\s+)?(?:all\s+)?(?:my\s+|the\s+)?tasks?$/.test(l) || /^what(?:'s| is| are)\s+(?:on\s+)?my\s+(?:tasks?|to-?do(?: list)?|list)$/.test(l) || /^what do i have to do$/.test(l)) {
    go('tasks');
    const open = sortedTasks().filter(t => !t.done);
    if (!open.length) return 'You have no open tasks.';
    return `You have ${plural(open.length, 'open task')}. Top priority: ${open.slice(0, 3).map(t => t.text).join('; ')}.`;
  }

  /* ---- counts ---- */
  if ((m = l.match(/^how many\s+(.+)$/)) && /\b(?:notes?|tasks?|to-?dos?|reminders?|timers?|commands?)\b/.test(m[1])) {
    const w = m[1];
    if (/note/.test(w)) return `You have ${plural(data.notes.length, 'note')}.`;
    if (/timer/.test(w)) return `You have ${plural(activeReminders().filter(r => r.kind === 'timer').length, 'running timer')}.`;
    if (/reminder/.test(w)) return `You have ${plural(activeReminders().filter(r => r.kind !== 'timer').length, 'upcoming reminder')}.`;
    if (/command/.test(w)) return `You have run ${plural(data.conversations.length, 'command')}.`;
    if (/overdue|late/.test(w)) return `You have ${plural(data.tasks.filter(isOverdue).length, 'overdue task')}.`;
    if (/done|completed|finished/.test(w)) return `You have completed ${plural(data.tasks.filter(t => t.done).length, 'task')}.`;
    return `You have ${plural(data.tasks.filter(t => !t.done).length, 'open task')}.`;
  }

  /* ---- natural phrasing for tasks ---- */
  if ((m = s.match(/^(?:add|put|stick|throw)\s+(.+?)\s+(?:to|on|onto|in|into)\s+(?:my\s+|the\s+)?(?:tasks?|to-?do|todo|task list|to-?do list|todo list|list|checklist)$/i))) return createTask(m[1]);
  if ((m = s.match(/^(?:i(?:'ve| have)?\s+(?:need to|have to|got to|gotta|must|ought to|should)|i(?:'ll| will) need to|i need to|we need to|don't let me forget to|do not forget to|don't forget to)\s+(.+)$/i))) return createTask(m[1]);
  if ((m = s.match(/^(?:to-?do|to do|todo|new to-?do)[:\s]+(.+)$/i))) return createTask(m[1]);
  if ((m = s.match(/^(?:i(?:'ve| have)?\s+)?(?:finished|completed|done with|done)\s+(.+)$/i))) {
    const t = tryTask(m[1], true);
    if (t) { editMemory('tasks', t.id, { done: true, completed: nowISO() }); return `Nice work. Marked complete: ${t.text}.`; }
  }
  if ((m = s.match(/^mark\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)$/i))) {
    const t = tryTask(m[1], true);
    if (t) { editMemory('tasks', t.id, { done: true, completed: nowISO() }); return `Marked complete: ${t.text}.`; }
  }

  /* ---- utilities ---- */
  if (/\bwhat(?:'s| is)?\s+the\s+time\b|^what time is it$|^time$|^what(?:'s| is) the time now$/.test(l)) return 'It is ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.';
  if (/\b(?:what(?:'s| is)?\s+(?:the\s+)?(?:date|day)|today'?s date)\b/.test(l) && !/\d/.test(l)) return 'Today is ' + new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + '.';
  if (/^(?:hello|hi|hey|good (?:morning|afternoon|evening)|yo|sup)$/.test(l)) return 'Hello. All systems are online.';
  if (/^(?:thanks|thank you|thanks jarvis|thank you jarvis)$/.test(l)) return 'You are welcome.';
  if (/^how are you(?: doing)?(?: today)?$/.test(l)) return 'All systems nominal. Ready when you are.';
  if (/^(?:who are you|what(?:'s| is) your name|what are you)$/.test(l)) return 'I am Mars Jarvis, your personal AI operating system.';
  if (/^good night$/.test(l)) return 'Good night. I will keep watch.';
  if (/^(?:mute|be quiet|silence|shut up)$/.test(l)) { setMuted(true); return ''; }
  if (/^unmute$/.test(l)) { setMuted(false); return 'Voice restored.'; }
  if (/^(?:stop listening|go to sleep|sleep)$/.test(l)) { setTimeout(stopListening, 1500); return 'Going quiet. Say start listening on the console to wake me.'; }

  if (/\bjokes?\b|^make me laugh$|^say something funny$/.test(l)) {
    let j; do { j = pick(JOKES); } while (j === ui.lastJoke && JOKES.length > 1);
    ui.lastJoke = j; return j;
  }
  if (/^(?:flip|toss)\s+(?:a\s+)?coin$/.test(l)) return Math.random() < 0.5 ? 'Heads.' : 'Tails.';
  if (/^(?:roll|throw)\s+(?:a\s+|the\s+)?(?:die|dice|d6)$/.test(l)) return `You rolled a ${1 + Math.floor(Math.random() * 6)}.`;
  if ((m = l.match(/^(?:pick|give me|choose|random)\s+(?:a\s+)?(?:random\s+)?number(?:\s+between\s+(\d+)\s+(?:and|to)\s+(\d+))?$/))) {
    let a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : 100; if (a > b) [a, b] = [b, a];
    return `${a + Math.floor(Math.random() * (b - a + 1))}.`;
  }
  if ((m = l.match(/^(?:pick|choose|decide)\s+(?:between\s+)?(.+?)\s+or\s+(.+)$/))) return `I choose ${Math.random() < 0.5 ? m[1] : m[2]}.`;

  if ((m = l.match(/^(?:set|change|update)\s+(?:my\s+)?(?:city|location|home|town)\s+(?:to|as|is)\s+(.+)$/)) || (m = l.match(/^(?:my (?:city|location|home) is|i live in|i(?:'m| am) in)\s+(.+)$/)))
    return setHome(m[1]);
  if (!/^help/.test(l) && (/\b(?:weather|forecast|temperature)\b/.test(l) || /^(?:is it|will it|do i need|should i bring).*\b(?:rain|raining|umbrella|snow|hot|cold|sunny)\b/.test(l))) {
    const c = l.match(/\b(?:in|for|at)\s+(?!the\b|my\b|today\b|tomorrow\b|now\b|here\b)([a-z][a-z\s.,'-]*?)(?:\s+(?:today|tomorrow|right now|now))?$/);
    return weatherReport(c ? c[1].trim() : '');
  }

  const calc = evalMath(l);
  if (calc !== null) return `${calc}.`;

  /* ---- AI brain (explicit) ---- */
  if (BRAIN_TRIGGER.test(l) && !/^(?:write|draft)\s+(?:down|a note|note)/.test(l)) {
    if (!brainReady()) { if (ui.noBrain) return undefined; return /^(?:ask|ai|chat)\b/.test(l) ? NO_KEY_MSG : googleSearch(s); }
    return askBrain(s.replace(/^ask(?: ai| jarvis)?[,:\s]+/i, ''));
  }

  /* ---- web ---- */
  if ((m = l.match(/^(?:open|launch|go to|visit|pull up|take me to|start)\s+(?:the\s+)?(?:website\s+)?([a-z0-9 .\/-]+?)(?:\s+(?:app|website|site|page))?$/))) {
    const key = m[1].trim();
    if (SITES[key]) { openUrl(SITES[key], cap(key)); return `Opening ${cap(key)}.`; }
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/.test(key)) { openUrl('https://' + key, key); return `Opening ${key}.`; }
  }
  if ((m = s.match(/^(?:search\s+)?(?:you ?tube)\s+(?:for\s+)?(.+)$/i)) || (m = s.match(/^(?:search|look up|find|show me)\s+(.+?)\s+on\s+you ?tube$/i)) || (m = s.match(/^play\s+(.+?)\s+on\s+you ?tube$/i)) || (m = s.match(/^play\s+(.+)$/i)))
    return youtubeSearch(m[1]);
  if ((m = s.match(/^(?:navigate|directions?|route|take me|drive|walk|get directions?|how do i get)\s+(?:me\s+)?(?:to|for)\s+(.+)$/i)))
    return mapsRoute(m[1]);
  if ((m = s.match(/^(?:find|show|search for|look for|where(?:'s| is)?)\s+(?:me\s+)?(?:the\s+)?(?:nearest|closest|nearby)\s+(.+)$/i)) || (m = s.match(/^(?:nearest|closest)\s+(.+)$/i))) return mapsSearch(m[1] + ' near me');
  if ((m = s.match(/^(?:find|show|search for|look for)\s+(?:me\s+)?(.+?)\s+(?:near me|nearby|around here|near here)$/i))) return mapsSearch(m[1] + ' near me');
  if ((m = s.match(/^(?:find|show|search|look up|where is|where's)\s+(.+?)\s+(?:on|in|using)\s+(?:google\s+)?maps$/i)) || (m = s.match(/^(?:maps?|map of)\s+(.+)$/i))) return mapsSearch(m[1]);
  if ((m = s.match(/^(?:wikipedia|wiki)\s+(?:for\s+|about\s+)?(.+)$/i))) { openUrl('https://en.wikipedia.org/wiki/Special:Search?search=' + enc(m[1]), 'Wikipedia: ' + m[1]); return `Looking up ${m[1]} on Wikipedia.`; }
  if ((m = s.match(/^(?:google|search google for|search for|search the web for|search the internet for|search online for|web search|search|look up|look)\s+(?:for\s+)?(.+)$/i)) || (m = s.match(/^(?:find me|find)\s+(?:information|info)\s+(?:on|about)\s+(.+)$/i)))
    return googleSearch(m[1]);
  if (/^(?:who|what|when|where|why|how|which)\b.{4,}/.test(l)) return brainReady() ? askBrain(s) : googleSearch(s);
  for (const f of ext.fallback) { const r = f(s, l, raw); if (r !== undefined) return r; }

  /* ---- help ---- */
  if (/^(?:help|what can you do|commands|what do you know)$/.test(l))
    return 'I can save and read notes, manage tasks with priorities and due dates, set timers and reminders, do quick math, search Google, YouTube and Maps, check the weather, tell jokes, and chat if you add an AI key in Settings. Try: set a timer for 10 minutes, or remind me at 5 pm to call mom.';
  if ((m = l.match(/^help(?: me)? with\s+(notes?|tasks?|timers?|reminders?|web|search|weather|math|fun)$/))) {
    const h2 = {
      note: 'For notes say: jot down something, read my notes, read note 2, rename note 2 to something, search notes for something, delete note 2.',
      task: 'For tasks say: I need to call mom, add high priority task pay rent due friday, complete task 1, clear completed tasks, what is overdue, how many tasks.',
      timer: 'For timers say: set a timer for 10 minutes, how much time is left, cancel the timer.',
      reminder: 'For reminders say: remind me in 30 minutes to stretch, remind me tomorrow at 9 to call mom, cancel all reminders.',
      web: 'For the web say: google something, search YouTube for something, directions to a place, open Gmail, open Maps.',
      search: 'For the web say: google something, search YouTube for something, directions to a place, open Gmail, open Maps.',
      weather: 'Say: what is the weather, or weather in Manila, or set my city to Baguio.',
      math: 'Say: what is 15 percent of 80, or 12 times 7, or square root of 144.',
      fun: 'Say: tell me a joke, flip a coin, roll a dice, or pick a number between 1 and 10.'
    };
    return h2[m[1].replace(/s$/, '')] || h2.web;
  }

  if (brainReady()) return askBrain(s);
  return "I didn't recognise that command. Say help, or say google followed by what you want to find. Add an AI key in Settings and I can chat too.";
}

function runCommand(text, source = 'text') {
  const input = text.trim();
  if (!input) return;
  let reply;
  try { reply = processCommand(input); }
  catch (e) { console.error(e); reply = 'Something went wrong running that command.'; }
  const finish = r => { logConversation(input, r, source); if (r) { speak(r); if (data.settings.muted) toast(r); } };
  if (reply && typeof reply.then === 'function') {
    toast('Working on it…');
    reply.then(finish, e => { console.error(e); finish('I could not reach the internet for that.'); });
  } else finish(reply);
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
  renderHome(); renderNotes(); renderTasks(); renderReminders(); renderHistory(); renderMemoryMeta(); renderAuth(); renderSettings();
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
      h('span', { class: 't-text' }, t.text, t.due ? h('small', { style: 'margin-left:8px;opacity:.85;color:' + (isOverdue(t) ? 'var(--red)' : 'var(--gold)') }, (isOverdue(t) ? 'overdue · ' : 'due ') + fmtDue(t.due)) : null),
      h('button', {
        class: 'badge ' + t.priority, title: 'Click to change priority',
        onclick: () => editMemory('tasks', t.id, { priority: { high: 'medium', medium: 'low', low: 'high' }[t.priority] })
      }, t.priority),
      h('button', { class: 'icon-btn', title: 'Delete', onclick: () => deleteMemory('tasks', t.id) }, '✕')));
  });
}

function renderReminders() {
  const ul = $('#remList'); if (!ul) return;
  const list = activeReminders();
  ul.innerHTML = '';
  if (!list.length) { ul.append(h('li', { class: 'empty' }, 'Nothing scheduled. Say “Jarvis, set a timer for 10 minutes”.')); return; }
  list.slice(0, 6).forEach(r => {
    const due = new Date(r.due);
    const info = r.kind === 'timer' ? '⏱ ' + fmtDur(Math.max(0, due - Date.now())) + ' left' : '🔔 ' + fmtWhen(due);
    ul.append(h('li', {}, r.text, h('span', { class: 'meta' }, info + ' · '), h('button', { class: 'btn small', style: 'margin-left:6px', onclick: () => deleteMemory('reminders', r.id) }, 'Cancel')));
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
  const parts = [`${data.notes.length} notes`, `${data.tasks.length} tasks`, `${data.reminders.filter(r => !r.fired).length} reminders`, `${data.research.length} research`, `${data.conversations.length} conversations`];
  let s = parts.join(' · ');
  if (!signedIn()) s += ' · Not connected: data lives in this tab only.';
  else if (sync.lastSaved) s += ' · Last saved ' + fmtTime(sync.lastSaved);
  $('#memoryMeta').textContent = s;
  $('#dataInspector').textContent = JSON.stringify(data, null, 2);
}

function renderAuth() {
  const on = signedIn();
  const top = $('#topAuth');
  top.textContent = on ? (auth.needTap ? '⚠ Tap to reconnect' : '● ' + (sync.user ? sync.user.emailAddress : 'Drive connected')) : (remembered() ? 'Reconnect Drive' : 'Connect Drive');
  top.classList.toggle('on', on && !auth.needTap);
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
const CHEATS = [["Jarvis, jot down blockchain idea", "read my notes", "read note 2", "rename note 1 to …"], ["I need to call mom", "add high priority task pay rent due friday"], ["complete task 1", "clear completed tasks", "what is overdue", "undo"], ["set a timer for 10 minutes", "how much time is left", "cancel the timer"], ["remind me at 5 pm to call mom", "remind me in 30 minutes to stretch"], ["google best phone 2026", "search YouTube for lofi", "directions to SM Baguio", "open Gmail"], ["what is 15 percent of 80", "weather in Manila", "tell me a joke", "help"], ["ask why is the sky blue", "explain blockchain simply", "save that", "new chat"]];

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

  /* Phase 2 UI additions: timers panel, new cheat sheet, label */
  const brand = $('.brand-text span'); if (brand) brand.textContent = 'JARVIS · PHASE 3';
  const cheats = $('.cheats');
  if (cheats) {
    const grid = cheats.parentElement.parentElement;
    const panel = h('div', { class: 'glass panel' }, h('h3', {}, 'Timers & reminders'), h('ul', { id: 'remList', class: 'list' }));
    grid.insertBefore(panel, cheats.parentElement);
    cheats.innerHTML = '';
        CHEATS.forEach(line => cheats.append(h('li', {}, line.map((c, i) => [i ? ' · ' : '', h('code', {}, c)]).flat())))};
  const hi = $('#homeInput'); if (hi) hi.placeholder = 'Try: "remind me in 30 minutes to stretch"';
  setInterval(() => { checkReminders(); renderReminders(); }, 1000);
  mountBrainSettings();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && remembered() && !auth.pending && (!auth.token || auth.expires - Date.now() < 5 * 60000)) {
      if (await silentRefresh()) { auth.needTap = false; renderAuth(); if (!sync.fileId) { try { await loadMemory(); } catch (_) {} } } else if (auth.token || sync.fileId) { auth.needTap = true; renderAuth(); armTapReconnect(); }
    }
  });
  setSync('offline'); renderAll(); updateVoiceUI();
  if (data.settings.autoListen && SR) startListening();
  autoConnect();
}
boot();

/* expose memory API for future phases (console / modules) */
window.MarsJarvis = { get data() { return data; }, saveMemory, loadMemory, addMemory, editMemory, deleteMemory, runCommand, go };

/* plugin system: list extra script files in plugins.json (optional) and they load automatically */
ext.api = { get data() { return data; }, ui, $, $$, h, toast, speak, touch, uid, nowISO, cap, plural, syncNote, signedIn, go, createNote, createTask, addMemory, editMemory, deleteMemory, runCommand, processCommand, askBrain, brainReady, setMuted };
fetch('plugins.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : [])).then(list => {
  (Array.isArray(list) ? list : []).forEach(f => { if (/^[\w.-]+\.js$/.test(f)) document.head.append(h('script', { src: f })); });
}).catch(() => {});
})();
