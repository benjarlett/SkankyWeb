import { initDB, saveFile, deleteFile } from './db.js';
import * as Player from './player.js';

// ── Constants ──────────────────────────────────────────────────────────────

const KEYS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function transposedKey(key, semitones) {
  const idx = KEYS.indexOf(key);
  if (idx === -1) return null;
  return KEYS[((idx + semitones) % 12 + 12) % 12];
}

function keyLabel(loop) {
  if (!loop.key) return '';
  const orig = loop.key;
  const shift = (loop.transposeSemitones || 0);
  if (shift === 0) return orig;
  const dest = transposedKey(orig, shift);
  return dest && dest !== orig ? `${orig}→${dest}` : orig;
}

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  loops: [],
  setlists: [],
  bands: [],
  currentTab: 'loops',
  currentFilter: 'all',
  expandedLoopId: null,
  searchQuery: '',
  gigOpen: false,
  gigIndex: 0,
  reorderMode: false,
};

// ── Persistence ────────────────────────────────────────────────────────────

function loadState() {
  try {
    const raw = localStorage.getItem('skanky_data');
    if (raw) {
      const data = JSON.parse(raw);
      state.loops     = data.loops     || [];
      state.setlists  = data.setlists  || [];
      state.bands     = data.bands     || [];
    }
  } catch (e) { console.error('Failed to load state', e); }
  ensureUnknownBand();
}

function saveState() {
  localStorage.setItem('skanky_data', JSON.stringify({
    loops: state.loops, setlists: state.setlists, bands: state.bands,
  }));
}

function ensureUnknownBand() {
  if (!state.bands.find(b => b.name === 'Unknown')) {
    state.bands.push({ id: uid(), name: 'Unknown' });
    saveState();
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getFilteredLoops() {
  let list;
  if (state.currentFilter === 'all') {
    list = [...state.loops].sort((a, b) => a.title.localeCompare(b.title));
  } else {
    const sl = state.setlists.find(s => s.name === state.currentFilter);
    list = sl ? sl.loopIds.map(id => state.loops.find(l => l.id === id)).filter(Boolean) : [];
  }

  const q = state.searchQuery.trim();
  if (!q || typeof Fuse === 'undefined') return list;

  const fuse = new Fuse(list, {
    keys: ['title', 'band', 'chords', 'notes'],
    threshold: 0.4,
    ignoreLocation: true,
  });
  return fuse.search(q).map(r => r.item);
}

function findLoop(id) { return state.loops.find(l => l.id === id); }

// ── Render helpers ─────────────────────────────────────────────────────────

function renderFilterBar() {
  const onLoops = state.currentTab === 'loops';
  const opts = [
    `<option value="all" ${state.currentFilter === 'all' ? 'selected' : ''}>All Loops</option>`,
    ...state.setlists.map(sl =>
      `<option value="${esc(sl.name)}" ${state.currentFilter === sl.name ? 'selected' : ''}>${esc(sl.name)}</option>`
    ),
  ].join('');
  const sel = document.getElementById('filter-select');
  sel.innerHTML = opts;
  sel.style.display = onLoops ? '' : 'none';

  const gigBtn = document.getElementById('gig-btn');
  gigBtn.style.display = onLoops ? '' : 'none';
}

// ── Render: Loop list ──────────────────────────────────────────────────────

function renderLoopsTab() {
  const loops = getFilteredLoops();
  const inSetlist = state.currentFilter !== 'all';
  const rows = loops.length
    ? loops.map(renderLoopRow).join('')
    : `<p class="empty-msg">${state.searchQuery ? 'No matches.' : 'No loops yet. Add audio files in Settings.'}</p>`;

  const reorderBtn = inSetlist
    ? `<button class="btn-reorder-toggle ${state.reorderMode ? 'active' : ''}" data-action="toggleReorderMode" aria-label="Toggle reorder mode">⇅</button>`
    : '';

  return `<div class="search-wrap">
    <input type="search" id="search-input" class="search-input"
      placeholder="Search loops…" value="${esc(state.searchQuery)}" autocomplete="off" spellcheck="false">
    ${state.searchQuery ? `<button class="btn-search-clear" data-action="clearSearch">✕</button>` : ''}
    ${reorderBtn}
  </div>
  <div id="loop-list">${rows}</div>`;
}

function renderLoopRow(loop) {
  const playing  = Player.currentLoopId === loop.id;
  const expanded = state.expandedLoopId === loop.id || playing;
  const speakerSrc = playing ? 'icons/speaker-red.svg' : 'icons/speaker-green.svg';
  const playIcon   = `<img src="${speakerSrc}" class="icon-speaker" alt="${playing ? 'Stop' : 'Play'}">`;
  const playClass  = playing ? 'btn-stop' : 'btn-go';
  const kl = keyLabel(loop);

  let expandedHtml = '';
  if (expanded) {
    const hasChords = loop.chords?.trim();
    const hasNotes  = loop.notes?.trim();
    const hasYT = loop.youtubeLink?.trim();
    const hasSP = loop.spotifyLink?.trim();
    if (hasChords || hasNotes || hasYT || hasSP) {
      expandedHtml = `<div class="loop-expanded">
        <div class="loop-expanded-left">
          ${hasChords ? `<p class="loop-chords">${esc(loop.chords)}</p>` : ''}
          ${hasNotes  ? `<p class="loop-notes">${esc(loop.notes)}</p>`  : ''}
        </div>
        <div class="loop-expanded-right">
          ${hasYT ? `<button class="media-btn" data-action="openMedia" data-url="${esc(loop.youtubeLink)}" data-mediatype="youtube" aria-label="YouTube"><img src="icons/youtube.svg" class="icon-media" alt="YouTube"></button>` : ''}
          ${hasSP ? `<button class="media-btn" data-action="openMedia" data-url="${esc(loop.spotifyLink)}" data-mediatype="spotify" aria-label="Spotify"><img src="icons/spotify.svg" class="icon-media" alt="Spotify"></button>` : ''}
        </div>
      </div>`;
    }
  }

  const inSetlist = state.currentFilter !== 'all';
  const reorderBtns = inSetlist && state.reorderMode ? `<div class="reorder-btns">
    <button class="btn-reorder" data-action="moveLoop" data-id="${loop.id}" data-delta="-1" aria-label="Move up">▲</button>
    <button class="btn-reorder" data-action="moveLoop" data-id="${loop.id}" data-delta="1" aria-label="Move down">▼</button>
  </div>` : '';

  return `<div class="loop-row${playing ? ' playing' : ''}" data-loop-id="${loop.id}">
    <div class="loop-row-main">
      ${reorderBtns}
      <button class="btn-icon btn-edit" data-action="editLoop" data-id="${loop.id}" aria-label="Edit">&#9998;</button>
      <div class="loop-info" data-action="toggleExpand" data-id="${loop.id}">
        <span class="loop-title">${esc(loop.title)}</span>
        <span class="loop-band">
          ${esc(loop.band)}${loop.looping ? ' <span class="loop-badge">↺</span>' : ''}
          ${kl ? `<span class="key-badge">${esc(kl)}</span>` : ''}
        </span>
      </div>
      <button class="btn-play ${playClass}" data-action="togglePlay" data-id="${loop.id}" aria-label="${playing ? 'Stop' : 'Play'}">
        ${playIcon}
      </button>
    </div>
    ${expandedHtml}
  </div>`;
}

// ── Render: Setlists ───────────────────────────────────────────────────────

function renderSetlistsTab() {
  const rows = state.setlists.map(sl => `
    <div class="setlist-row">
      <span class="setlist-name">${esc(sl.name)}</span>
      <div class="setlist-actions">
        <button class="btn-sm" data-action="renameSetlist" data-id="${sl.id}">Rename</button>
        <button class="btn-sm btn-danger" data-action="deleteSetlist" data-id="${sl.id}">Delete</button>
      </div>
    </div>`).join('');
  return `<div class="setlists-view">
    <button class="btn-primary" data-action="newSetlist">+ New Setlist</button>
    ${rows || '<p class="empty-msg">No setlists yet.</p>'}
  </div>`;
}

// ── Render: Settings ───────────────────────────────────────────────────────

function renderSettingsTab() {
  const bandRows = state.bands.map(b => `
    <div class="band-row">
      <span>${esc(b.name)}</span>
      ${b.name !== 'Unknown' ? `<button class="btn-sm btn-danger" data-action="deleteBand" data-id="${b.id}">Remove</button>` : ''}
    </div>`).join('');
  return `<div class="settings-view">
    <section class="settings-section">
      <h2>Audio Files</h2>
      <label class="btn-primary file-label" for="file-input">Add Audio Files</label>
      <input type="file" id="file-input" accept="audio/*,.wav,.mp3,.m4a,.aiff,.aif,.ogg,.flac" multiple>
    </section>
    <section class="settings-section">
      <h2>Bands</h2>
      <div id="bands-list">${bandRows}</div>
      <div class="input-row">
        <input type="text" id="new-band-input" placeholder="New band name" autocomplete="off">
        <button class="btn-primary" data-action="addBand">Add</button>
      </div>
    </section>
    <section class="settings-section">
      <h2>Data</h2>
      <button class="btn-primary" data-action="exportCSV">Export CSV</button>
      <label class="btn-primary file-label" for="import-input">Import CSV</label>
      <input type="file" id="import-input" accept=".csv" multiple>
    </section>
  </div>`;
}

// ── Render: Edit Modal ─────────────────────────────────────────────────────

function renderEditModal(loop) {
  const bandOpts = state.bands.map(b =>
    `<option value="${esc(b.name)}" ${b.name === loop.band ? 'selected' : ''}>${esc(b.name)}</option>`
  ).join('');

  const keyOpts = ['', ...KEYS].map(k =>
    `<option value="${k}" ${(loop.key || '') === k ? 'selected' : ''}>${k || '— not set —'}</option>`
  ).join('');

  const setlistToggles = state.setlists.map(sl => `
    <label class="toggle-row">
      <span>${esc(sl.name)}</span>
      <input type="checkbox" name="setlist" value="${esc(sl.name)}" ${loop.setlists.includes(sl.name) ? 'checked' : ''}>
    </label>`).join('');

  const semitones = loop.transposeSemitones || 0;
  const cents     = loop.tuneCents || 0;
  const kl = keyLabel(loop);

  return `<div class="modal-header">
    <button class="btn-modal-close" data-action="closeModal">✕</button>
    <h2 class="modal-title">${esc(loop.title) || 'Edit Loop'}</h2>
    <button class="btn-modal-save" data-action="saveLoop" data-id="${loop.id}">Save</button>
  </div>
  <div class="modal-body">
    <form id="edit-form" autocomplete="off">
      <div class="form-group">
        <label>Title</label>
        <input type="text" name="title" value="${esc(loop.title)}" placeholder="Loop title">
      </div>
      <div class="form-group">
        <label>Band</label>
        <select name="band">${bandOpts}</select>
      </div>
      <div class="form-group">
        <label>Key (original recording)</label>
        <select name="key">${keyOpts}</select>
      </div>
      <label class="toggle-row form-group">
        <span>Loop Playback</span>
        <input type="checkbox" name="looping" ${loop.looping ? 'checked' : ''}>
      </label>
      <div class="form-group">
        <label>Transpose: <span class="pitch-display" id="semitones-display">${semitones}</span> semitones
          ${kl ? `<span class="key-badge key-badge-modal">${esc(kl)}</span>` : ''}
        </label>
        <div class="stepper">
          <button type="button" class="btn-step" data-action="stepPitch" data-target="transposeSemitones" data-delta="-1">−</button>
          <input type="range" name="transposeSemitones" min="-12" max="12" step="1" value="${semitones}">
          <button type="button" class="btn-step" data-action="stepPitch" data-target="transposeSemitones" data-delta="1">+</button>
        </div>
      </div>
      <div class="form-group">
        <label>Tune: <span class="pitch-display" id="cents-display">${cents}</span> cents</label>
        <div class="stepper">
          <button type="button" class="btn-step" data-action="stepPitch" data-target="tuneCents" data-delta="-1">−</button>
          <input type="range" name="tuneCents" min="-100" max="100" step="1" value="${cents}">
          <button type="button" class="btn-step" data-action="stepPitch" data-target="tuneCents" data-delta="1">+</button>
        </div>
      </div>
      <div class="form-group">
        <label>YouTube Link</label>
        <input type="url" name="youtubeLink" value="${esc(loop.youtubeLink || '')}" placeholder="https://youtube.com/watch?v=...">
      </div>
      <div class="form-group">
        <label>Spotify Link</label>
        <input type="url" name="spotifyLink" value="${esc(loop.spotifyLink || '')}" placeholder="https://open.spotify.com/track/...">
      </div>
      <div class="form-group">
        <label>Chords</label>
        <textarea name="chords" rows="3" placeholder="Dm  G  Am  C...">${esc(loop.chords || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea name="notes" rows="3" placeholder="Rehearsal notes...">${esc(loop.notes || '')}</textarea>
      </div>
      ${state.setlists.length > 0 ? `<div class="form-group"><label>Setlists</label>${setlistToggles}</div>` : ''}
      <div class="form-group">
        <button type="button" class="btn-danger btn-full" data-action="confirmDelete" data-id="${loop.id}">Delete Loop</button>
      </div>
    </form>
  </div>`;
}

// ── Gig Mode ───────────────────────────────────────────────────────────────

function renderGigScreen() {
  const loops = getFilteredLoops();
  if (!loops.length) return '<p style="color:#888;padding:2rem;text-align:center">No loops to show</p>';

  const idx  = Math.max(0, Math.min(state.gigIndex, loops.length - 1));
  state.gigIndex = idx;
  const loop = loops[idx];
  const playing = Player.currentLoopId === loop.id;
  const kl = keyLabel(loop);
  const hasYT = loop.youtubeLink?.trim();
  const hasSP = loop.spotifyLink?.trim();

  return `<div class="gig-screen">
    <div class="gig-header">
      <button class="gig-exit" data-action="closeGig">✕</button>
      <span class="gig-pos">${idx + 1} / ${loops.length}</span>
      <div class="gig-media-links">
        ${hasYT ? `<button class="media-btn" data-action="openMedia" data-url="${esc(loop.youtubeLink)}" data-mediatype="youtube" aria-label="YouTube"><img src="icons/youtube.svg" class="icon-media" alt="YT"></button>` : ''}
        ${hasSP ? `<button class="media-btn" data-action="openMedia" data-url="${esc(loop.spotifyLink)}" data-mediatype="spotify" aria-label="Spotify"><img src="icons/spotify.svg" class="icon-media" alt="SP"></button>` : ''}
      </div>
    </div>

    <div class="gig-body">
      <h1 class="gig-title">${esc(loop.title)}</h1>
      <p class="gig-band">${esc(loop.band)}</p>
      ${kl ? `<p class="gig-key">${esc(kl)}</p>` : ''}
      ${loop.chords?.trim() ? `<p class="gig-chords">${esc(loop.chords)}</p>` : ''}
      ${loop.notes?.trim()  ? `<p class="gig-notes">${esc(loop.notes)}</p>`   : ''}
    </div>

    <div class="gig-footer">
      <button class="gig-play-btn ${playing ? 'gig-stop' : ''}" data-action="gigTogglePlay" data-id="${loop.id}">
        <img src="${playing ? 'icons/speaker-red.svg' : 'icons/speaker-green.svg'}" class="gig-speaker" alt="${playing ? 'Stop' : 'Play'}">
        ${playing ? 'STOP' : 'PLAY'}
      </button>
      <div class="gig-nav">
        <button class="gig-nav-btn" data-action="gigNav" data-delta="-1" ${idx === 0 ? 'disabled' : ''}>◀ Prev</button>
        <button class="gig-nav-btn" data-action="gigNav" data-delta="1"  ${idx === loops.length - 1 ? 'disabled' : ''}>Next ▶</button>
      </div>
    </div>
  </div>`;
}

function openGigMode() {
  // Start at the currently playing loop, or 0
  const loops = getFilteredLoops();
  const playingIdx = loops.findIndex(l => l.id === Player.currentLoopId);
  state.gigIndex = playingIdx >= 0 ? playingIdx : 0;
  state.gigOpen = true;
  const overlay = document.getElementById('gig-overlay');
  overlay.innerHTML = renderGigScreen();
  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeGigMode() {
  state.gigOpen = false;
  document.getElementById('gig-overlay').classList.add('hidden');
  document.body.classList.remove('modal-open');
}

function refreshGig() {
  if (!state.gigOpen) return;
  document.getElementById('gig-overlay').innerHTML = renderGigScreen();
}

function navigateGig(delta) {
  const loops = getFilteredLoops();
  state.gigIndex = Math.max(0, Math.min(state.gigIndex + delta, loops.length - 1));
  refreshGig();
}

// ── DOM helpers ────────────────────────────────────────────────────────────

const content = () => document.getElementById('app-content');

function render() {
  const c = content();
  switch (state.currentTab) {
    case 'loops':    c.innerHTML = renderLoopsTab(); bindSearchInput(); break;
    case 'setlists': c.innerHTML = renderSetlistsTab(); break;
    case 'settings': c.innerHTML = renderSettingsTab(); bindSettingsInputs(); break;
  }
  renderFilterBar();
  updateTabBar();
  if (state.gigOpen) refreshGig();
}

function updateTabBar() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === state.currentTab);
  });
}

function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.body.classList.add('modal-open');
  bindModalPitchSliders();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.body.classList.remove('modal-open');
}

function openMediaModal(url, type) {
  let embedUrl = url;
  if (type === 'youtube') {
    const m = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (m) embedUrl = `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1`;
  } else if (type === 'spotify') {
    const m = url.match(/open\.spotify\.com\/(track|album|playlist|artist)\/([A-Za-z0-9]+)/);
    if (m) embedUrl = `https://open.spotify.com/embed/${m[1]}/${m[2]}`;
  }
  document.getElementById('media-frame').src = embedUrl;
  document.getElementById('media-overlay').classList.remove('hidden');
}

function closeMediaModal() {
  document.getElementById('media-frame').src = '';
  document.getElementById('media-overlay').classList.add('hidden');
}

// ── Search input binding ───────────────────────────────────────────────────

function bindSearchInput() {
  const input = document.getElementById('search-input');
  if (!input) return;
  input.addEventListener('input', e => {
    state.searchQuery = e.target.value;
    const loops = getFilteredLoops();
    const listEl = document.getElementById('loop-list');
    if (listEl) {
      listEl.innerHTML = loops.length
        ? loops.map(renderLoopRow).join('')
        : `<p class="empty-msg">${state.searchQuery ? 'No matches.' : 'No loops yet.'}</p>`;
    }
    // Update clear button
    const wrap = document.querySelector('.search-wrap');
    if (wrap) {
      const existing = wrap.querySelector('.btn-search-clear');
      if (state.searchQuery && !existing) {
        const btn = document.createElement('button');
        btn.className = 'btn-search-clear';
        btn.dataset.action = 'clearSearch';
        btn.textContent = '✕';
        wrap.appendChild(btn);
      } else if (!state.searchQuery && existing) {
        existing.remove();
      }
    }
  });
  // Prevent form submission on Enter
  input.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
}

// ── Modal pitch slider live binding ───────────────────────────────────────

function bindModalPitchSliders() {
  const form = document.getElementById('edit-form');
  if (!form) return;
  const semSlider   = form.querySelector('[name="transposeSemitones"]');
  const centsSlider = form.querySelector('[name="tuneCents"]');
  const keySelect   = form.querySelector('[name="key"]');

  function updateKeyLabel() {
    const semVal = Number(semSlider?.value ?? 0);
    const keyVal = keySelect?.value || '';
    const kl = keyVal ? (semVal !== 0 ? (transposedKey(keyVal, semVal) ?? keyVal) : keyVal) : '';
    const display = semVal !== 0 && keyVal && kl !== keyVal ? `${keyVal}→${kl}` : kl;
    const badge = form.querySelector('.key-badge-modal');
    if (badge) badge.textContent = display;
    else if (display) {
      const label = document.getElementById('semitones-display')?.closest('label');
      if (label && !label.querySelector('.key-badge-modal')) {
        const span = document.createElement('span');
        span.className = 'key-badge key-badge-modal';
        span.textContent = display;
        label.appendChild(span);
      }
    }
  }

  const onSem = () => {
    document.getElementById('semitones-display').textContent = semSlider.value;
    updateKeyLabel();
    if (Player.isPlaying) Player.updatePitch(Number(semSlider.value), Number(centsSlider?.value ?? 0));
  };
  const onCents = () => {
    document.getElementById('cents-display').textContent = centsSlider.value;
    if (Player.isPlaying) Player.updatePitch(Number(semSlider?.value ?? 0), Number(centsSlider.value));
  };

  semSlider?.addEventListener('input', onSem);
  centsSlider?.addEventListener('input', onCents);
  keySelect?.addEventListener('change', updateKeyLabel);
}

// ── Settings file inputs ───────────────────────────────────────────────────

function bindSettingsInputs() {
  document.getElementById('file-input')?.addEventListener('change', async e => {
    await handleAddFiles(Array.from(e.target.files));
    e.target.value = '';
    render();
  });
  document.getElementById('import-input')?.addEventListener('change', async e => {
    await handleImportCSV(Array.from(e.target.files));
    e.target.value = '';
    render();
  });
}

// ── Action handlers ────────────────────────────────────────────────────────

async function handleTogglePlay(id) {
  if (Player.currentLoopId === id) {
    await Player.stop();
    state.expandedLoopId = null;
    render();
    return;
  }
  const loop = findLoop(id);
  if (!loop) return;
  state.expandedLoopId = id;
  render();
  const ok = await Player.play(id, loop.filename, loop);
  if (!ok) {
    alert(`Audio file for "${loop.title}" not found. Re-import it in Settings.`);
    state.expandedLoopId = null;
  }
  render();
}

function handleToggleExpand(id) {
  state.expandedLoopId = state.expandedLoopId === id ? null : id;
  render();
}

function handleEditLoop(id) {
  const loop = findLoop(id);
  if (loop) openModal(renderEditModal(loop));
}

function handleSaveLoop(id) {
  const form = document.getElementById('edit-form');
  if (!form) return;
  const fd = new FormData(form);
  const idx = state.loops.findIndex(l => l.id === id);
  if (idx === -1) return;
  const checkedSetlists = [...form.querySelectorAll('[name="setlist"]:checked')].map(cb => cb.value);
  state.loops[idx] = {
    ...state.loops[idx],
    title:             fd.get('title')             || state.loops[idx].title,
    band:              fd.get('band')              || state.loops[idx].band,
    key:               fd.get('key')              || '',
    looping:           form.querySelector('[name="looping"]')?.checked ?? false,
    transposeSemitones: Number(fd.get('transposeSemitones')) || 0,
    tuneCents:          Number(fd.get('tuneCents'))           || 0,
    youtubeLink:       fd.get('youtubeLink') || null,
    spotifyLink:       fd.get('spotifyLink') || null,
    chords:            fd.get('chords')      || '',
    notes:             fd.get('notes')       || '',
    setlists:          checkedSetlists,
  };
  state.setlists.forEach(sl => {
    const inLoop = checkedSetlists.includes(sl.name);
    const loopId = state.loops[idx].id;
    if (inLoop  && !sl.loopIds.includes(loopId)) sl.loopIds.push(loopId);
    if (!inLoop) sl.loopIds = sl.loopIds.filter(lid => lid !== loopId);
  });
  saveState();
  closeModal();
  render();
}

async function handleDeleteLoop(id) {
  const loop = findLoop(id);
  if (!loop) return;
  if (Player.currentLoopId === id) await Player.stop();
  await deleteFile(loop.filename).catch(() => {});
  state.loops = state.loops.filter(l => l.id !== id);
  state.setlists.forEach(sl => { sl.loopIds = sl.loopIds.filter(lid => lid !== id); });
  saveState();
  closeModal();
  render();
}

async function handleAddFiles(files) {
  for (const file of files) {
    await saveFile(file.name, file);
    if (!state.loops.find(l => l.filename === file.name)) {
      state.loops.push({
        id: uid(), title: file.name.replace(/\.[^.]+$/, ''),
        band: 'Unknown', filename: file.name, key: '',
        looping: false, spotifyLink: null, youtubeLink: null,
        setlists: [], transposeSemitones: 0, tuneCents: 0, notes: '', chords: '',
      });
    }
  }
  saveState();
}

function handleAddBand() {
  const input = document.getElementById('new-band-input');
  const name  = input?.value.trim();
  if (!name || state.bands.find(b => b.name.toLowerCase() === name.toLowerCase())) return;
  state.bands.push({ id: uid(), name });
  state.bands.sort((a, b) => a.name.localeCompare(b.name));
  saveState();
  render();
}

function handleDeleteBand(id) {
  state.bands = state.bands.filter(b => b.id !== id);
  state.loops.forEach(l => { if (!state.bands.find(b => b.name === l.band)) l.band = 'Unknown'; });
  saveState();
  render();
}

function handleNewSetlist() {
  const name = prompt('Setlist name:');
  if (!name?.trim()) return;
  state.setlists.push({ id: uid(), name: name.trim(), loopIds: [] });
  saveState();
  render();
}

function handleRenameSetlist(id) {
  const sl = state.setlists.find(s => s.id === id);
  if (!sl) return;
  const name = prompt('New name:', sl.name);
  if (!name?.trim() || name.trim() === sl.name) return;
  const old = sl.name;
  sl.name = name.trim();
  state.loops.forEach(l => {
    const i = l.setlists.indexOf(old);
    if (i !== -1) l.setlists[i] = sl.name;
  });
  if (state.currentFilter === old) state.currentFilter = sl.name;
  saveState();
  render();
}

function handleDeleteSetlist(id) {
  const sl = state.setlists.find(s => s.id === id);
  if (!sl || !confirm(`Delete setlist "${sl.name}"?`)) return;
  state.loops.forEach(l => { l.setlists = l.setlists.filter(n => n !== sl.name); });
  state.setlists = state.setlists.filter(s => s.id !== id);
  if (state.currentFilter === sl.name) state.currentFilter = 'all';
  saveState();
  render();
}

function handleMoveLoop(loopId, delta) {
  const sl = state.setlists.find(s => s.name === state.currentFilter);
  if (!sl) return;
  const idx = sl.loopIds.indexOf(loopId);
  if (idx === -1) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= sl.loopIds.length) return;
  sl.loopIds.splice(idx, 1);
  sl.loopIds.splice(newIdx, 0, loopId);
  saveState();
  render();
}

function handleStepPitch(target, delta) {
  const form  = document.getElementById('edit-form');
  const input = form?.querySelector(`[name="${target}"]`);
  if (!input) return;
  const newVal = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) + delta));
  input.value = newVal;
  input.dispatchEvent(new Event('input'));
}

// ── CSV Export ─────────────────────────────────────────────────────────────

function handleExportCSV() {
  const csvLoops = [
    'id,title,band,filepath,looping,spotifyLink,youtubeLink,setlists,transposeSemitones,tuneCents,notes,chords,key',
    ...state.loops.map(l =>
      [l.id, csvEsc(l.title), csvEsc(l.band), csvEsc(l.filename), l.looping,
       csvEsc(l.spotifyLink||''), csvEsc(l.youtubeLink||''),
       `"${l.setlists.join(';')}"`, l.transposeSemitones, l.tuneCents,
       csvEsc(l.notes||''), csvEsc(l.chords||''), csvEsc(l.key||'')].join(',')
    ),
  ].join('\n');
  const csvBands    = ['name', ...state.bands.map(b => csvEsc(b.name))].join('\n');
  const csvSetlists = ['name,loopIds', ...state.setlists.map(sl => `${csvEsc(sl.name)},"${sl.loopIds.join(';')}"`),].join('\n');
  downloadText('loops.csv',    csvLoops);
  setTimeout(() => downloadText('bands.csv',    csvBands),    300);
  setTimeout(() => downloadText('setlists.csv', csvSetlists), 600);
}

function csvEsc(s) {
  s = String(s ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadText(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── CSV Import ─────────────────────────────────────────────────────────────

async function handleImportCSV(files) {
  const get = name => files.find(f => f.name === name);
  const loopsFile = get('loops.csv'), bandsFile = get('bands.csv'), setlistsFile = get('setlists.csv');
  if (!loopsFile || !bandsFile || !setlistsFile) {
    alert('Please select all three files: loops.csv, bands.csv, setlists.csv'); return;
  }
  const [loopsText, bandsText, setlistsText] = await Promise.all([
    loopsFile.text(), bandsFile.text(), setlistsFile.text(),
  ]);
  const bands    = parseBandsCSV(bandsText);
  const loops    = parseLoopsCSV(loopsText);
  const setlists = parseSetlistsCSV(setlistsText, loops);
  state.bands = bands; state.loops = loops; state.setlists = setlists;
  ensureUnknownBand();
  saveState();
  alert('Import successful!');
}

function parseLoopsCSV(text) {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  return rows.slice(1).map(row => {
    const c = csvSplit(row);
    if (c.length < 12) return null;
    return {
      id: c[0] || uid(), title: c[1], band: c[2], filename: c[3],
      looping: c[4].toLowerCase() === 'true',
      spotifyLink: c[5] || null, youtubeLink: c[6] || null,
      setlists: c[7] ? c[7].split(';').filter(Boolean) : [],
      transposeSemitones: Number(c[8]) || 0, tuneCents: Number(c[9]) || 0,
      notes: c[10] || '', chords: c[11] || '',
      key: c[12] || '',
    };
  }).filter(Boolean);
}

function parseBandsCSV(text) {
  return csvRows(text).slice(1).map(r => ({ id: uid(), name: csvSplit(r)[0] })).filter(b => b.name);
}

function parseSetlistsCSV(text, loops) {
  const loopMap = Object.fromEntries(loops.map(l => [l.id, l.id]));
  return csvRows(text).slice(1).map(r => {
    const c = csvSplit(r);
    return { id: uid(), name: c[0], loopIds: (c[1]||'').split(';').filter(id => loopMap[id]) };
  }).filter(s => s.name);
}

function csvRows(text) {
  const rows = []; let row = '', inQ = false;
  for (const ch of text + '\n') {
    if (ch === '"') { inQ = !inQ; row += ch; }
    else if (ch === '\n' && !inQ) { if (row.trim()) rows.push(row.trim()); row = ''; }
    else if (ch !== '\r') { row += ch; }
  }
  return rows;
}

function csvSplit(row) {
  const fields = []; let f = '', inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQ) {
      if (ch === '"' && row[i+1] === '"') { f += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { f += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ',') { fields.push(f); f = ''; }
      else { f += ch; }
    }
  }
  fields.push(f);
  return fields;
}

// ── Event delegation ───────────────────────────────────────────────────────

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, delta, target: pitchTarget, url, mediatype } = el.dataset;

  switch (action) {
    case 'togglePlay':    await handleTogglePlay(id); break;
    case 'toggleExpand':  handleToggleExpand(id); break;
    case 'editLoop':      handleEditLoop(id); break;
    case 'saveLoop':      handleSaveLoop(id); break;
    case 'closeModal':    closeModal(); break;
    case 'confirmDelete':
      if (confirm(`Delete "${findLoop(id)?.title}"? This cannot be undone.`)) await handleDeleteLoop(id);
      break;
    case 'newSetlist':    handleNewSetlist(); break;
    case 'renameSetlist': handleRenameSetlist(id); break;
    case 'deleteSetlist': handleDeleteSetlist(id); break;
    case 'deleteBand':    handleDeleteBand(id); break;
    case 'addBand':       handleAddBand(); break;
    case 'exportCSV':     handleExportCSV(); break;
    case 'stepPitch':     handleStepPitch(pitchTarget, Number(delta)); break;
    case 'moveLoop':      handleMoveLoop(id, Number(delta)); break;
    case 'toggleReorderMode':
      state.reorderMode = !state.reorderMode;
      render();
      break;
    case 'openMedia':     openMediaModal(url, mediatype); break;
    case 'clearSearch':
      state.searchQuery = '';
      render();
      document.getElementById('search-input')?.focus();
      break;
    case 'openGig':       openGigMode(); break;
    case 'closeGig':      closeGigMode(); break;
    case 'gigNav':        navigateGig(Number(delta)); break;
    case 'gigTogglePlay':
      await handleTogglePlay(id);
      refreshGig();
      break;
  }
});

// Tab bar
document.getElementById('tab-bar').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  state.currentTab = btn.dataset.tab;
  state.searchQuery = '';
  render();
});

// Filter select
document.getElementById('filter-select').addEventListener('change', e => {
  state.currentFilter = e.target.value;
  state.reorderMode = false;
  render();
});

// Gig button
document.getElementById('gig-btn').addEventListener('click', openGigMode);

// Media modal
document.getElementById('media-close').addEventListener('click', closeMediaModal);
document.getElementById('media-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('media-overlay')) closeMediaModal();
});

// Modal overlay click to close
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

// Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeMediaModal(); closeGigMode(); }
  if (state.gigOpen) {
    if (e.key === 'ArrowRight') navigateGig(1);
    if (e.key === 'ArrowLeft')  navigateGig(-1);
  }
});

// Playback ended
document.addEventListener('playbackEnded', () => { render(); refreshGig(); });

// ── Gig mode swipe ─────────────────────────────────────────────────────────

let touchStartX = 0, touchStartY = 0;

document.getElementById('gig-overlay').addEventListener('touchstart', e => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

document.getElementById('gig-overlay').addEventListener('touchend', e => {
  if (!state.gigOpen) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dx) > 50 && Math.abs(dy) < 80) {
    navigateGig(dx < 0 ? 1 : -1);
  }
}, { passive: true });

// ── Splash ─────────────────────────────────────────────────────────────────

function showSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  setTimeout(() => {
    splash.classList.add('fade-out');
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  }, 1800);
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function init() {
  showSplash();
  await initDB();
  loadState();
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW:', e));
  }
}

init();
