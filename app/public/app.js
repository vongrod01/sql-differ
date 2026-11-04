'use strict';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const $app = document.getElementById('app');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-database-diff': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Compare runs read as changes to the target (it becomes like the source): "only in source" is
// something to add (green), "only in target" something to remove (red). Drift reads from the older
// side to the later one, so the colours and words flip.
function onlyIn(kind) {
  if (kind === 'drift') {
    return { source: { cls: 'src', label: 'มีแค่ "จาก"' }, target: { cls: 'tgt', label: 'มีแค่ "ถึง"' } };
  }
  return { source: { cls: 'tgt', label: 'มีแค่ source' }, target: { cls: 'src', label: 'มีแค่ target' } };
}

function countsHtml(c, incomplete, kind) {
  if (!c) return '<span class="muted">-</span>';
  const total = c.onlyInSource + c.onlyInTarget + c.different;
  const o = onlyIn(kind);
  const parts = [];
  if (total === 0 && !c.unverified) parts.push('<span class="tag ok">เหมือนกัน</span>');
  if (c.onlyInSource) parts.push(`<span class="tag ${o.source.cls}">${o.source.label} ${c.onlyInSource}</span>`);
  if (c.onlyInTarget) parts.push(`<span class="tag ${o.target.cls}">${o.target.label} ${c.onlyInTarget}</span>`);
  if (c.different) parts.push(`<span class="tag chg">ต่างกัน ${c.different}</span>`);
  if (c.unverified) parts.push(`<span class="tag">เทียบไม่ได้ ${c.unverified}</span>`);
  if (incomplete) parts.push('<span class="tag err">ผลไม่ครบ</span>');
  return `<div class="counts">${parts.join('')}</div>`;
}

function statusTag(status) {
  if (status === 'running') return '<span class="tag run"><span class="spinner"></span> กำลังรัน</span>';
  if (status === 'done') return '<span class="tag ok">เสร็จ</span>';
  return '<span class="tag err">ล้มเหลว</span>';
}

const KIND_LABEL = { compare: 'ฐานเดียว', batch: 'หลายฐาน', drift: 'Drift' };

function runTitle(run) {
  const s = run.spec;
  if (s.kind === 'batch') {
    const dbs = s.allDatabases ? 'ทุกฐานที่ชื่อตรงกัน' : s.databases.join(', ');
    return `${esc(s.source.serverLabel)} &rarr; ${esc(s.target.serverLabel)}<div class="muted small">${esc(dbs)}</div>`;
  }
  const src = run.sourceLabel || (s.source.snapshot ? `snapshot ${s.source.database || ''}` : `${s.source.serverLabel} / ${s.source.database}`);
  const tgt = run.targetLabel || (s.target.snapshot ? `snapshot ${s.target.database || ''}` : `${s.target.serverLabel} / ${s.target.database}`);
  return `${esc(src)}<div class="muted small">&rarr; ${esc(tgt)}</div>`;
}

// Delete buttons ask for a second click instead of opening a browser dialog.
function armDelete(button, action) {
  if (!button.classList.contains('armed')) {
    button.classList.add('armed');
    button.dataset.label = button.textContent;
    button.textContent = 'กดอีกครั้งเพื่อยืนยัน';
    setTimeout(() => {
      if (button.isConnected) { button.classList.remove('armed'); button.textContent = button.dataset.label; }
    }, 4000);
    return;
  }
  action();
}

function showError(target, err) {
  target.innerHTML = `<div class="notice error">${esc(err.message || err)}</div>`;
}

// ---------------------------------------------------------------------------------------------
// Servers and database lists (cached per page load)
// ---------------------------------------------------------------------------------------------

let serverCache = null;
const dbCache = new Map();

async function getServers(refresh) {
  if (!serverCache || refresh) serverCache = await api('GET', '/api/servers');
  return serverCache;
}

function getDatabases(serverId, refresh) {
  if (refresh || !dbCache.has(serverId)) {
    const p = api('GET', `/api/servers/${encodeURIComponent(serverId)}/databases`);
    p.catch(() => dbCache.delete(serverId));
    dbCache.set(serverId, p);
  }
  return dbCache.get(serverId);
}

function serverOption(s, selected) {
  const address = s.port ? `${s.server},${s.port}` : s.server;
  const name = s.kind === 'builtin' ? `localhost (Windows auth)` : `${s.name} - ${address}`;
  const suffix = s.kind === 'mcp' ? ' [mssql-mcp]' : '';
  return `<option value="${esc(s.id)}"${s.id === selected ? ' selected' : ''}>${esc(name + suffix)}</option>`;
}

// ---------------------------------------------------------------------------------------------
// Spec form: source/target, single or batch, options. Used by Compare and Schedules.
// ---------------------------------------------------------------------------------------------

const MAIN_CATEGORIES = ['Table', 'Column', 'View', 'Stored procedure', 'Function'];
const EXTRA_CATEGORIES = ['Index', 'Foreign key', 'Check constraint', 'Trigger', 'User-defined type', 'Sequence', 'Synonym', 'Schema', 'Database'];
const CATEGORY_LABEL = { Database: 'Database settings' };

function categoryBox(selected) {
  const chosen = new Set(selected && selected.length ? selected : MAIN_CATEGORIES);
  const box = (c) => `<label class="check"><input type="checkbox" data-category="${esc(c)}"${chosen.has(c) ? ' checked' : ''}>${esc(CATEGORY_LABEL[c] || c)}</label>`;
  return `<div class="panel" data-role="categories">
    <div class="side-title">หมวดที่เปรียบเทียบ</div>
    <div class="cat-row"><span class="cat-label">หลัก</span><div>${MAIN_CATEGORIES.map(box).join('')}</div></div>
    <div class="cat-row"><span class="cat-label">เพิ่มเติม</span><div>${EXTRA_CATEGORIES.map(box).join('')}</div></div>
    <div class="row"><button type="button" class="link" data-cat-preset="main">ค่าเริ่มต้น (5 หมวดหลัก)</button><span class="muted">|</span><button type="button" class="link" data-cat-preset="all">ทั้งหมด</button></div>
  </div>`;
}

function wireCategoryBox(root) {
  root.querySelectorAll('[data-cat-preset]').forEach((b) => b.addEventListener('click', () => {
    const all = b.dataset.catPreset === 'all';
    root.querySelectorAll('[data-category]').forEach((c) => { c.checked = all || MAIN_CATEGORIES.includes(c.dataset.category); });
  }));
}

function readCategories(root) {
  const list = [...root.querySelectorAll('[data-category]:checked')].map((c) => c.dataset.category);
  if (!list.length) throw new Error('เลือกหมวดที่จะเปรียบเทียบอย่างน้อย 1 หมวด');
  return list;
}

const OPTIONS = [
  ['ignoreWhitespace', 'ไม่สนช่องว่าง (whitespace)'],
  ['ignoreCase', 'ไม่สนตัวพิมพ์เล็ก/ใหญ่'],
  ['ignoreCollation', 'ไม่เทียบ collation'],
  ['compareColumnOrder', 'เทียบลำดับคอลัมน์ด้วย'],
];

// opts.onChange(draft) is called whenever the user changes anything; a draft may be incomplete.
async function specForm(root, initial, opts = {}) {
  const spec = initial || { kind: 'compare', source: { serverId: 'local' }, target: { serverId: 'local' }, options: {} };
  const list = await getServers();
  // A saved server that no longer exists is shown as missing (and blocks saving) rather than
  // letting the browser fall back to the first server in the list.
  const missing = (id) => (id && !list.some((s) => s.id === id) ? `<option value="" selected>ไม่พบ server: ${esc(id)}</option>` : '');
  const side = (name, title) => `
    <div class="panel">
      <div class="side-title">${title}</div>
      <label class="field"><span>Server</span>
        <select data-role="${name}-server">${missing(spec[name].serverId)}${list.map((s) => serverOption(s, spec[name].serverId)).join('')}</select></label>
      <label class="field single-only"><span>Database</span>
        <select data-role="${name}-db"><option value="">กำลังโหลด...</option></select></label>
      <div class="hint" data-role="${name}-info"></div>
    </div>`;

  root.innerHTML = `
    <div class="segmented" role="radiogroup" aria-label="รูปแบบ">
      <label><input type="radio" name="kind" value="compare"${spec.kind !== 'batch' ? ' checked' : ''}>ฐานเดียว</label>
      <label><input type="radio" name="kind" value="batch"${spec.kind === 'batch' ? ' checked' : ''}>หลายฐาน (batch)</label>
    </div>
    <div class="grid2">${side('source', 'Source (ต้นแบบ)')}${side('target', 'Target (ฝั่งที่เอามาเทียบ)')}</div>
    <div class="panel batch-only">
      <div class="side-title">ฐานที่จะเทียบ</div>
      <label class="check"><input type="radio" name="dbmode" value="all"${spec.allDatabases ? ' checked' : ''}>ทุกฐานที่ชื่อตรงกันทั้งสองฝั่ง (รวมฐานที่จะเพิ่มทีหลังด้วย)</label>
      <label class="check"><input type="radio" name="dbmode" value="pick"${spec.allDatabases ? '' : ' checked'}>เลือกเอง</label>
      <div data-role="pick-area">
        <div class="row"><button type="button" class="link" data-role="all">เลือกทั้งหมด</button><span class="muted">|</span><button type="button" class="link" data-role="none">ไม่เลือกเลย</button></div>
        <div class="db-grid" data-role="db-grid"><span class="muted">กำลังโหลด...</span></div>
      </div>
    </div>
    ${categoryBox(spec.categories)}
    <div class="panel">
      <div class="side-title">ตัวเลือก</div>
      ${OPTIONS.map(([k, label]) => `<label class="check"><input type="checkbox" data-option="${k}"${spec.options && spec.options[k] ? ' checked' : ''}>${label}</label>`).join('')}
    </div>`;

  const q = (role) => root.querySelector(`[data-role="${role}"]`);
  const kind = () => root.querySelector('input[name=kind]:checked').value;
  const state = { source: null, target: null };
  const failures = { source: false, target: false };
  let picked = new Set(spec.allDatabases ? [] : spec.databases || []);

  const applyKind = () => {
    const batch = kind() === 'batch';
    root.querySelectorAll('.single-only').forEach((e) => { e.hidden = batch; });
    root.querySelectorAll('.batch-only').forEach((e) => { e.hidden = !batch; });
    q('pick-area').hidden = root.querySelector('input[name=dbmode]:checked').value === 'all';
  };

  const renderGrid = () => {
    const grid = q('db-grid');
    const failed = ['source', 'target'].filter((n) => failures[n]);
    if (failed.length) { grid.innerHTML = `<span class="warn-text">โหลดรายชื่อฐานฝั่ง ${failed.join(', ')} ไม่ได้ ดูรายละเอียดใต้ช่อง Server</span>`; return; }
    if (!state.source || !state.target) { grid.innerHTML = '<span class="muted">กำลังโหลด...</span>'; return; }
    const targetByName = new Map(state.target.databases.map((d) => [d.name.toLowerCase(), d]));
    const common = state.source.databases.filter((d) => targetByName.has(d.name.toLowerCase()));
    if (!common.length) { grid.innerHTML = '<span class="muted">ไม่มีฐานที่ชื่อตรงกันทั้งสองฝั่ง</span>'; return; }
    grid.innerHTML = common.map((d) => {
      const t = targetByName.get(d.name.toLowerCase());
      const blocked = [d.hasAccess === false ? 'source' : '', t.hasAccess === false ? 'target' : ''].filter(Boolean);
      // A database the login cannot open is listed (so the list is complete) but cannot be picked.
      if (blocked.length) picked.delete(d.name);
      const note = blocked.length ? ` <span class="muted small">(เข้าไม่ได้ฝั่ง ${blocked.join(', ')})</span>` : '';
      return `<label class="check"><input type="checkbox" value="${esc(d.name)}"${picked.has(d.name) ? ' checked' : ''}${blocked.length ? ' disabled' : ''}>${esc(d.name)}${note}</label>`;
    }).join('');
  };

  const fillDb = async (name, preferred) => {
    const select = q(`${name}-db`);
    const info = q(`${name}-info`);
    const serverId = q(`${name}-server`).value;
    select.innerHTML = '<option value="">กำลังโหลด...</option>';
    info.textContent = '';
    state[name] = null;
    failures[name] = false;
    if (!serverId) {
      // A saved job or draft whose server has since been deleted.
      select.innerHTML = '<option value="">เลือก server ก่อน</option>';
      info.innerHTML = '<span class="warn-text">ไม่พบ server เดิมแล้ว เลือก server ใหม่</span>';
      failures[name] = true;
      renderGrid();
      return;
    }
    try {
      const result = await getDatabases(serverId);
      if (q(`${name}-server`).value !== serverId) return;
      state[name] = result;
      // No database is picked for the user; only an edited job (preferred) comes back selected.
      // Databases the login cannot open stay in the list (disabled) so it matches what the server has.
      select.innerHTML = '<option value="">-- เลือก database --</option>' +
        result.databases.map((d) => {
          const open = d.hasAccess !== false;
          const note = !open ? ' (เข้าไม่ได้)' : d.canViewDefinition ? '' : ' (ไม่มีสิทธิ์ VIEW DEFINITION)';
          return `<option value="${esc(d.name)}"${open && d.name === preferred ? ' selected' : ''}${open ? '' : ' disabled'}>${esc(d.name)}${note}</option>`;
        }).join('');
      const accessible = result.databases.filter((d) => d.hasAccess !== false);
      const noAccess = result.databases.length - accessible.length;
      const noView = accessible.filter((d) => !d.canViewDefinition).length;
      info.innerHTML = `${esc(result.edition)} ${esc(result.version)} &middot; login ${esc(result.login)}` +
        (noAccess ? `<div class="warn-text">login นี้เข้าได้ ${accessible.length} จาก ${result.databases.length} ฐาน (ฐานที่เข้าไม่ได้แสดงไว้แต่เลือกไม่ได้)</div>` : '') +
        (noView ? `<div class="warn-text">ไม่มีสิทธิ์ VIEW DEFINITION ใน ${noView} ฐานที่เข้าได้ ผลเทียบของฐานเหล่านั้นจะไม่ครบ</div>` : '');
    } catch (err) {
      if (q(`${name}-server`).value !== serverId) return;
      select.innerHTML = '<option value="">โหลดไม่ได้</option>';
      info.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`;
      failures[name] = true;
    }
    renderGrid();
  };

  root.querySelectorAll('input[name=kind], input[name=dbmode]').forEach((r) => r.addEventListener('change', applyKind));
  wireCategoryBox(root);
  q('source-server').addEventListener('change', () => fillDb('source'));
  q('target-server').addEventListener('change', () => fillDb('target'));
  // Picking a source database selects the same name on the target when it exists.
  q('source-db').addEventListener('change', () => {
    const name = q('source-db').value;
    const option = [...q('target-db').options].find((o) => o.value.toLowerCase() === name.toLowerCase());
    if (option) q('target-db').value = option.value;
  });
  q('db-grid').addEventListener('change', (e) => {
    if (e.target.checked) picked.add(e.target.value); else picked.delete(e.target.value);
  });
  q('all').addEventListener('click', () => { q('db-grid').querySelectorAll('input:not(:disabled)').forEach((i) => { i.checked = true; picked.add(i.value); }); });
  q('none').addEventListener('click', () => { picked = new Set(); q('db-grid').querySelectorAll('input').forEach((i) => { i.checked = false; }); });

  const getDraft = () => {
    const options = {};
    root.querySelectorAll('[data-option]').forEach((c) => { options[c.dataset.option] = c.checked; });
    return {
      kind: kind(),
      source: { serverId: q('source-server').value, database: q('source-db').value },
      target: { serverId: q('target-server').value, database: q('target-db').value },
      allDatabases: root.querySelector('input[name=dbmode]:checked').value === 'all',
      databases: [...picked],
      categories: [...root.querySelectorAll('[data-category]:checked')].map((c) => c.dataset.category),
      options,
    };
  };
  // Root listeners run after the element listeners above, so the draft sees their updates
  // (for example the target database picked to match the source).
  const emit = () => { if (opts.onChange) opts.onChange(getDraft()); };
  root.addEventListener('change', emit);
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-cat-preset], [data-role=all], [data-role=none]')) emit();
  });

  applyKind();
  await Promise.all([fillDb('source', spec.source.database), fillDb('target', spec.target.database)]);

  return {
    getDraft,
    getSpec() {
      const options = {};
      root.querySelectorAll('[data-option]').forEach((c) => { options[c.dataset.option] = c.checked; });
      const out = {
        kind: kind(),
        source: { serverId: q('source-server').value },
        target: { serverId: q('target-server').value },
        categories: readCategories(root),
        options,
      };
      if (!out.source.serverId || !out.target.serverId) throw new Error('เลือก server ทั้งสองฝั่งก่อน');
      if (out.kind === 'batch') {
        out.allDatabases = root.querySelector('input[name=dbmode]:checked').value === 'all';
        // Only what the grid shows ticked: a pick kept from another server or an old draft is not
        // on screen and must not be sent.
        out.databases = out.allDatabases ? [] : [...q('db-grid').querySelectorAll('input:checked:not(:disabled)')].map((i) => i.value);
        if (!out.allDatabases && !out.databases.length) throw new Error('เลือกฐานอย่างน้อย 1 ฐาน');
      } else {
        out.source.database = q('source-db').value;
        out.target.database = q('target-db').value;
        if (!out.source.database || !out.target.database) throw new Error('เลือก database ทั้งสองฝั่งก่อน');
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

// The compare form remembers its choices (also across reloads) until the user presses Reset.
// localStorage can be unavailable (private window, blocked storage): then it lasts for this page load.
const DRAFT_KEY = 'database-diff.compare-draft';
let draftInMemory = null;

function loadDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (saved && saved.source && saved.target) return saved;
  } catch { /* fall back to memory */ }
  return draftInMemory;
}

function saveDraft(draft) {
  draftInMemory = draft;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* memory only */ }
}

function clearDraft() {
  draftInMemory = null;
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* memory only */ }
}

async function pageCompare() {
  $app.innerHTML = `
    <div class="page-head"><div><h1>เปรียบเทียบ schema</h1>
      <div class="muted">อ่านอย่างเดียว ไม่แก้ไขฐานข้อมูลใดๆ</div></div></div>
    <div id="form"></div>
    <div class="row" style="margin-top:16px">
      <button class="primary" id="start">เริ่มเปรียบเทียบ</button>
      <button id="reset">รีเซต</button>
      <span class="hint" style="margin:0">ระบบจำตัวเลือกไว้ให้จนกว่าจะกดรีเซต</span>
      <span id="msg"></span>
    </div>`;
  document.getElementById('reset').addEventListener('click', () => {
    clearDraft();
    pageCompare();
  });
  const formEl = document.getElementById('form');
  const startButton = document.getElementById('start');
  let form;
  try {
    form = await specForm(formEl, loadDraft() || undefined, { onChange: saveDraft });
  } catch (err) {
    return showError(formEl, err);
  }
  // Reset or another page replaced this page while the lists loaded; the newer page wires its own
  // button, and wiring it here too would start a second run from this stale form.
  if (!startButton.isConnected) return;
  startButton.addEventListener('click', async (e) => {
    const msg = document.getElementById('msg');
    msg.textContent = '';
    try {
      e.target.disabled = true;
      const { id } = await api('POST', '/api/runs', form.getSpec());
      location.hash = `#/runs/${id}`;
    } catch (err) {
      msg.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`;
      e.target.disabled = false;
    }
  });
}

let activeStream = null;

async function pageRun(id) {
  $app.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  let meta;
  try {
    meta = await api('GET', `/api/runs/${id}`);
  } catch (err) {
    return showError($app, err);
  }
  $app.innerHTML = `
    <div class="page-head"><div>
      <h1>${KIND_LABEL[meta.spec.kind]} <span id="status">${statusTag(meta.status)}</span></h1>
      <div class="muted small">เริ่ม ${fmtTime(meta.createdAt)}${meta.spec.jobName ? ` &middot; ตั้งเวลา: ${esc(meta.spec.jobName)}` : ''}</div>
    </div><div class="actions" id="links"></div></div>
    <div class="panel">${runTitle(meta)}
      <div class="muted small" style="margin-top:6px">หมวดที่เปรียบเทียบ: ${esc((meta.spec.categories || MAIN_CATEGORIES).map((c) => CATEGORY_LABEL[c] || c).join(', '))}</div></div>
    <div id="result"></div>
    <h2>Log</h2><pre class="log" id="log"></pre>`;

  const log = document.getElementById('log');
  const renderDone = (final) => {
    document.getElementById('status').innerHTML = statusTag(final.status);
    const links = document.getElementById('links');
    const result = document.getElementById('result');
    if (final.status !== 'done') {
      result.innerHTML = `<div class="notice error">การรันล้มเหลว ${esc(final.resultError || '')} ดูรายละเอียดใน log</div>`;
      return;
    }
    // Open and download buttons of one script.
    const linkButtons = (href, label, downloadLabel) =>
      `<a class="btn" href="${href}" target="_blank" rel="noopener">${label}</a>` +
      `<a class="btn" href="${href}?download=1">${downloadLabel}</a>`;
    const scriptButtons = (file, label, downloadLabel) =>
      (file ? linkButtons(`/runs/${final.id}/${encodeURIComponent(file)}`, label, downloadLabel) : '');
    // A batch run joins every database's script into one file on the server (runs.combinedScript).
    // It includes only databases with objects to create or change; keep this rule the same as there.
    const toApply = (key) => (final.databases || []).some((d) => !d.error && d[key] && d.counts &&
      (d.counts.onlyInSource || 0) + (d.counts.different || 0) > 0);
    const combinedSync = toApply('syncScript');
    const combinedRollback = toApply('rollbackScript');
    // In a drift run the sync script is already the way back, so it has no rollback button.
    const drift = final.spec.kind === 'drift';
    links.innerHTML = `<a class="btn primary" href="/runs/${final.id}/${final.report}" target="_blank" rel="noopener">เปิดรายงาน</a>` +
      (drift
        ? scriptButtons(final.syncScript, 'Script ย้อนกลับ', 'ดาวน์โหลด .sql')
        : scriptButtons(final.syncScript, 'Sync script', 'ดาวน์โหลด sync .sql') +
          scriptButtons(final.rollbackScript, 'Rollback script', 'ดาวน์โหลด rollback .sql')) +
      (combinedSync ? linkButtons(`/runs/${final.id}/combined/sync.sql`, 'Sync script ทั้งหมด', 'ดาวน์โหลด sync ทั้งหมด .sql') : '') +
      (combinedRollback ? linkButtons(`/runs/${final.id}/combined/rollback.sql`, 'Rollback script ทั้งหมด', 'ดาวน์โหลด rollback ทั้งหมด .sql') : '');
    const c = final.counts || {};
    const o = onlyIn(final.spec.kind);
    let html = `<div class="cards">
      <div class="card ${o.source.cls}"><span class="n">${c.onlyInSource || 0}</span>${o.source.label}</div>
      <div class="card ${o.target.cls}"><span class="n">${c.onlyInTarget || 0}</span>${o.target.label}</div>
      <div class="card chg"><span class="n">${c.different || 0}</span>ต่างกัน</div>
      <div class="card unk"><span class="n">${c.unverified || 0}</span>เทียบไม่ได้</div></div>`;
    if (final.incomplete) {
      html += '<div class="notice warn">ผลไม่ครบ: login อย่างน้อยหนึ่งฝั่งไม่มีสิทธิ์ VIEW DEFINITION object ที่มองไม่เห็นจะขึ้นเป็น "มีแค่..." และ definition จะขึ้นเป็น "เทียบไม่ได้"</div>';
    }
    if (final.syncError) html += `<div class="notice error">สร้าง sync script ไม่สำเร็จ: ${esc(final.syncError)}</div>`;
    if (!drift && final.rollbackError) html += `<div class="notice error">สร้าง rollback script ไม่สำเร็จ: ${esc(final.rollbackError)}</div>`;
    if (final.syncScript || (final.databases && final.databases.some((d) => d.syncScript))) {
      html += drift
        ? '<div class="notice">Script ย้อนกลับ: ถ้ารันบนฝั่ง "ถึง" จะทำให้ schema กลับไปเป็นแบบ "จาก" ระบบไม่รัน script ให้ ต้อง review และรันเองใน SSMS</div>'
        : '<div class="notice">Sync script: ถ้ารันบนฝั่ง target จะทำให้ schema ตรงกับ source ระบบไม่รัน script ให้ ต้อง review และรันเองใน SSMS คำสั่งที่ลบของ (DROP) ถูก comment ไว้ท้ายไฟล์</div>';
    }
    if (!drift && (final.rollbackScript || (final.databases && final.databases.some((d) => d.rollbackScript)))) {
      html += '<div class="notice">Rollback script: รันบน target หลังรัน sync script แล้ว เพื่อย้อน schema กลับเป็นแบบตอนเปรียบเทียบ (ใช้ได้เมื่อหลังเปรียบเทียบ target ถูกแก้โดย sync script เท่านั้น) ' +
        'ของที่ sync script สร้างใหม่: procedure, view, function, trigger, index และ constraint จะถูก DROP ส่วน table และ column ถูก comment ไว้ท้ายไฟล์ เพราะลบแล้วข้อมูลหาย</div>';
    }
    if (combinedSync) {
      html += '<div class="notice">Sync script ทั้งหมด: รวม sync script ของทุก database ที่มีของต้องสร้างหรือแก้ไว้ในไฟล์เดียว เปิดใน SSMS ที่ต่อกับ server target แล้วรันทีเดียวได้ ' +
        'ก่อนแต่ละส่วนมี USE ของ database นั้น ถ้าเข้า database ไหนไม่ได้ (เช่นต่อผิด server) script จะหยุดทั้งไฟล์ ไม่รันใส่ database ผิดตัว ' +
        'database ที่ไม่มีอะไรต้องแก้ไม่ได้ใส่ไว้ รายชื่ออยู่ที่หัวไฟล์' +
        (combinedRollback ? ' ส่วน Rollback script ทั้งหมด ใช้ย้อนหลังรัน Sync script ทั้งหมดแล้ว' : '') + '</div>';
    }
    if (final.databases) {
      html += `<div class="table-wrap"><table><thead><tr><th>Database</th><th>ผลลัพธ์</th><th></th></tr></thead><tbody>${final.databases.map((d) => `
        <tr><td>${esc(d.database)}</td>
        <td>${d.error ? `<span class="warn-text">${esc(d.error)}</span>` : countsHtml(d.counts, d.incomplete, final.spec.kind)}</td>
        <td><div class="actions">${d.report ? `<a href="/runs/${final.id}/${encodeURIComponent(d.report)}" target="_blank" rel="noopener">รายงาน</a>` : ''}
          ${d.syncScript ? `<a href="/runs/${final.id}/${encodeURIComponent(d.syncScript)}" target="_blank" rel="noopener">sync script</a>` : ''}
          ${d.rollbackScript ? `<a href="/runs/${final.id}/${encodeURIComponent(d.rollbackScript)}" target="_blank" rel="noopener">rollback script</a>` : ''}</div></td></tr>`).join('')}
      </tbody></table></div>`;
      if (final.onlyOnSource && final.onlyOnSource.length) html += `<p class="muted small">ฐานที่มีแค่ฝั่ง source: ${esc(final.onlyOnSource.join(', '))}</p>`;
      if (final.onlyOnTarget && final.onlyOnTarget.length) html += `<p class="muted small">ฐานที่มีแค่ฝั่ง target: ${esc(final.onlyOnTarget.join(', '))}</p>`;
      if (final.noAccess && final.noAccess.length) {
        const names = final.noAccess.map((d) => `${d.database} (${[d.source ? '' : 'source', d.target ? '' : 'target'].filter(Boolean).join(', ')})`);
        html += `<div class="notice warn">มีทั้งสองฝั่งแต่ login เข้าไม่ได้ ${final.noAccess.length} ฐาน จึงไม่ได้เทียบ: ${esc(names.join(', '))}</div>`;
      }
    }
    result.innerHTML = html;
  };

  if (activeStream) activeStream.close();
  const stream = new EventSource(`/api/runs/${id}/events`);
  activeStream = stream;
  stream.addEventListener('line', (e) => {
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    log.textContent += JSON.parse(e.data) + '\n';
    if (atBottom) log.scrollTop = log.scrollHeight;
  });
  stream.addEventListener('end', (e) => {
    stream.close();
    renderDone(JSON.parse(e.data));
  });
  stream.onerror = () => stream.close();
}

async function pageHistory() {
  $app.innerHTML = '<div class="page-head"><h1>ประวัติการเปรียบเทียบ</h1></div><div id="list"><div class="empty"><span class="spinner"></span></div></div>';
  const target = document.getElementById('list');
  let list;
  try {
    list = await api('GET', '/api/runs');
  } catch (err) {
    return showError(target, err);
  }
  if (!list.length) {
    target.innerHTML = '<div class="panel empty">ยังไม่มีประวัติ เริ่มจากหน้า "เปรียบเทียบ"</div>';
    return;
  }
  target.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th>เวลา</th><th>ประเภท</th><th>Source &rarr; Target</th><th>ผลลัพธ์</th><th>สถานะ</th><th></th></tr></thead><tbody>
    ${list.map((r) => `<tr class="clickable" data-id="${r.id}">
      <td class="mono small">${fmtTime(r.createdAt)}</td>
      <td>${KIND_LABEL[r.spec.kind]}${r.spec.trigger === 'schedule' ? '<div class="muted small">ตั้งเวลา</div>' : ''}</td>
      <td>${runTitle(r)}</td>
      <td>${r.status === 'done' ? countsHtml(r.counts, r.incomplete, r.spec.kind) : ''}</td>
      <td>${statusTag(r.status)}</td>
      <td><div class="actions">${r.report ? `<a class="btn" href="/runs/${r.id}/${r.report}" target="_blank" rel="noopener">รายงาน</a>` : ''}
        ${r.status !== 'running' ? `<button class="danger" data-delete="${r.id}">ลบ</button>` : ''}</div></td></tr>`).join('')}
    </tbody></table></div>`;
  target.addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete]');
    if (del) {
      e.stopPropagation();
      armDelete(del, async () => {
        try { await api('DELETE', `/api/runs/${del.dataset.delete}`); del.closest('tr').remove(); } catch (err) { alertInline(target, err); }
      });
      return;
    }
    if (e.target.closest('a')) return;
    const row = e.target.closest('tr[data-id]');
    if (row) location.hash = `#/runs/${row.dataset.id}`;
  });
}

function alertInline(target, err) {
  target.insertAdjacentHTML('afterbegin', `<div class="notice error">${esc(err.message || err)}</div>`);
}

async function pageDrift() {
  $app.innerHTML = `<div class="page-head"><div><h1>Schema drift</h1>
    <div class="muted">ดูว่า schema ของฐานหนึ่งเปลี่ยนไปอย่างไรระหว่างสองช่วงเวลา ใช้ snapshot ที่เก็บไว้ทุกครั้งที่รันเปรียบเทียบ</div></div></div>
    <div id="body"><div class="empty"><span class="spinner"></span></div></div>`;
  const body = document.getElementById('body');
  let snaps;
  try {
    snaps = await api('GET', '/api/snapshots');
  } catch (err) {
    return showError(body, err);
  }
  const groups = new Map();
  for (const s of snaps) {
    const key = `${s.serverId}|${String(s.database).toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { key, serverId: s.serverId, serverLabel: s.serverLabel, database: s.database, items: [] });
    // One snapshot per run and server/database is enough (the same database can be on both sides).
    const g = groups.get(key);
    if (!g.items.some((i) => i.runId === s.runId)) g.items.push(s);
  }
  if (!groups.size) {
    body.innerHTML = '<div class="panel empty">ยังไม่มี snapshot รันการเปรียบเทียบอย่างน้อยหนึ่งครั้งก่อน</div>';
    return;
  }
  const sorted = [...groups.values()].sort((a, b) => (a.serverLabel + a.database).localeCompare(b.serverLabel + b.database));
  body.innerHTML = `
    <div class="panel"><label class="field"><span>Server / database</span>
      <select id="group">${sorted.map((g) => `<option value="${esc(g.key)}">${esc(g.serverLabel)} / ${esc(g.database)} (${g.items.length} snapshot)</option>`).join('')}</select></label></div>
    <div id="points"></div>
    <div style="margin-top:16px">${categoryBox()}</div>
    <div class="row" style="margin-top:16px"><button class="primary" id="go">เทียบ drift</button><span id="msg"></span></div>`;
  wireCategoryBox(body);

  const renderPoints = () => {
    const g = groups.get(document.getElementById('group').value);
    const rows = g.items.map((s, i) => `<tr>
      <td><input type="radio" name="from" value="${i}"${i === 0 ? ' checked' : ''} aria-label="จาก"></td>
      <td><input type="radio" name="to" value="${i}" aria-label="ถึง"></td>
      <td class="mono small">${fmtTime(s.capturedAt)}</td>
      <td><a href="#/runs/${s.runId}">ดูการรันที่เก็บ snapshot นี้</a></td></tr>`).join('');
    document.getElementById('points').innerHTML = `<div class="table-wrap" style="margin-top:16px"><table>
      <thead><tr><th>จาก</th><th>ถึง</th><th>เวลาที่เก็บ snapshot</th><th></th></tr></thead><tbody>
      <tr><td></td><td><input type="radio" name="to" value="live" checked aria-label="ถึง ปัจจุบัน"></td><td colspan="2"><b>ปัจจุบัน (อ่านจากฐานจริงตอนนี้)</b></td></tr>
      ${rows}</tbody></table></div>
      <div class="hint">"จาก" คือจุดเริ่ม "ถึง" คือจุดที่จะเทียบ: ผลจะแสดงสิ่งที่ถูกเพิ่ม/ลบ/แก้ ระหว่างสองจุด</div>`;
  };
  document.getElementById('group').addEventListener('change', renderPoints);
  renderPoints();

  document.getElementById('go').addEventListener('click', async (e) => {
    const msg = document.getElementById('msg');
    const g = groups.get(document.getElementById('group').value);
    const from = g.items[Number(document.querySelector('input[name=from]:checked').value)];
    const toValue = document.querySelector('input[name=to]:checked').value;
    let categories;
    try { categories = readCategories(body); } catch (err) { msg.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`; return; }
    const spec = {
      kind: 'drift',
      source: { snapshot: { runId: from.runId, file: from.file }, serverId: g.serverId, database: g.database },
      categories,
      options: {},
    };
    if (toValue === 'live') spec.target = { serverId: g.serverId, database: g.database };
    else {
      const to = g.items[Number(toValue)];
      if (to === from) { msg.innerHTML = '<span class="warn-text">เลือกจุด "จาก" กับ "ถึง" ให้ต่างกัน</span>'; return; }
      spec.target = { snapshot: { runId: to.runId, file: to.file }, serverId: g.serverId, database: g.database };
    }
    try {
      e.target.disabled = true;
      const { id } = await api('POST', '/api/runs', spec);
      location.hash = `#/runs/${id}`;
    } catch (err) {
      msg.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`;
      e.target.disabled = false;
    }
  });
}

const DAY_LABELS = [['MON', 'จ'], ['TUE', 'อ'], ['WED', 'พ'], ['THU', 'พฤ'], ['FRI', 'ศ'], ['SAT', 'ส'], ['SUN', 'อา']];

function scheduleText(s) {
  if (s.type === 'weekly') return `ทุก ${s.days.map((d) => (DAY_LABELS.find((x) => x[0] === d) || [d, d])[1]).join(', ')} เวลา ${s.time}`;
  return `ทุกวัน เวลา ${s.time}`;
}

function specText(spec) {
  const servers = serverCache || [];
  const name = (id) => { const s = servers.find((x) => x.id === id); return s ? (s.kind === 'builtin' ? 'localhost' : s.name) : id; };
  if (spec.kind === 'batch') return `${esc(name(spec.source.serverId))} &rarr; ${esc(name(spec.target.serverId))}: ${esc(spec.allDatabases ? 'ทุกฐานที่ชื่อตรงกัน' : spec.databases.join(', '))}`;
  return `${esc(name(spec.source.serverId))} / ${esc(spec.source.database)} &rarr; ${esc(name(spec.target.serverId))} / ${esc(spec.target.database)}`;
}

async function pageSchedules() {
  $app.innerHTML = `<div class="page-head"><div><h1>ตั้งเวลารันอัตโนมัติ</h1>
    <div class="muted">ใช้ Windows Task Scheduler รันเป็น user นี้ ขณะที่ login อยู่ ผลจะเข้าไปอยู่ในหน้าประวัติ (ไม่ต้องเปิดเว็บนี้ค้างไว้)</div></div>
    <button class="primary" id="new">สร้างงานใหม่</button></div><div id="editor"></div><div id="list"><div class="empty"><span class="spinner"></span></div></div>`;
  await getServers();
  const listEl = document.getElementById('list');
  const editor = document.getElementById('editor');

  const load = async () => {
    let jobs;
    try { jobs = await api('GET', '/api/jobs'); } catch (err) { return showError(listEl, err); }
    if (!jobs.length) { listEl.innerHTML = '<div class="panel empty">ยังไม่มีงานที่ตั้งเวลาไว้</div>'; return; }
    listEl.innerHTML = `<div class="table-wrap"><table><thead><tr><th>ชื่องาน</th><th>เปรียบเทียบ</th><th>เวลา</th><th>รอบถัดไป</th><th>ผลล่าสุด</th><th></th></tr></thead><tbody>
      ${jobs.map((j) => `<tr>
        <td><b>${esc(j.name)}</b>${j.enabled ? '' : '<div><span class="tag">ปิดอยู่</span></div>'}</td>
        <td class="small">${specText(j.spec)}</td>
        <td class="small">${scheduleText(j.schedule)}</td>
        <td class="small">${j.enabled ? (j.task.registered ? esc(j.task.nextRun) : '<span class="warn-text">ไม่พบใน Task Scheduler</span>') : '-'}</td>
        <td>${j.lastRun ? `<a href="#/runs/${j.lastRun.id}">${fmtTime(j.lastRun.createdAt)}</a>${j.lastRun.status === 'done' ? countsHtml(j.lastRun.counts, j.lastRun.incomplete, j.spec.kind) : statusTag(j.lastRun.status)}` : '<span class="muted">ยังไม่เคยรัน</span>'}</td>
        <td><div class="actions"><button data-run="${j.id}">รันตอนนี้</button><button data-edit="${j.id}">แก้ไข</button><button class="danger" data-delete="${j.id}">ลบ</button></div></td>
      </tr>`).join('')}</tbody></table></div>`;
    listEl.onclick = async (e) => {
      const run = e.target.closest('[data-run]');
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-delete]');
      try {
        if (run) { const { id } = await api('POST', `/api/jobs/${run.dataset.run}/run`); location.hash = `#/runs/${id}`; }
        if (edit) openEditor(jobs.find((j) => j.id === edit.dataset.edit));
        if (del) {
          armDelete(del, async () => {
            try { await api('DELETE', `/api/jobs/${del.dataset.delete}`); load(); } catch (err) { alertInline(listEl, err); }
          });
        }
      } catch (err) { alertInline(listEl, err); }
    };
  };

  const openEditor = async (job) => {
    const s = job ? job.schedule : { type: 'daily', time: '02:00', days: ['MON'] };
    editor.innerHTML = `<div class="panel" style="margin-bottom:16px">
      <h2 style="margin-top:0">${job ? 'แก้ไขงาน' : 'งานใหม่'}</h2>
      <label class="field"><span>ชื่องาน</span><input type="text" id="job-name" value="${esc(job ? job.name : '')}" placeholder="เช่น local เทียบ test ทุกคืน"></label>
      <div id="job-spec"></div>
      <div class="panel"><div class="side-title">เวลา</div>
        <div class="segmented"><label><input type="radio" name="stype" value="daily"${s.type !== 'weekly' ? ' checked' : ''}>ทุกวัน</label><label><input type="radio" name="stype" value="weekly"${s.type === 'weekly' ? ' checked' : ''}>บางวัน</label></div>
        <div id="days">${DAY_LABELS.map(([v, l]) => `<label class="check"><input type="checkbox" value="${v}"${s.days.includes(v) ? ' checked' : ''}>${l}</label>`).join('')}</div>
        <label class="field" style="max-width:180px"><span>เวลา (24 ชม.)</span><input type="time" id="job-time" value="${esc(s.time)}"></label>
        <label class="check"><input type="checkbox" id="job-enabled"${!job || job.enabled ? ' checked' : ''}>เปิดใช้งาน</label>
      </div>
      <div class="row" style="margin-top:16px"><button class="primary" id="job-save">บันทึก</button><button id="job-cancel">ยกเลิก</button><span id="job-msg"></span></div></div>`;
    const days = document.getElementById('days');
    const applyType = () => { days.hidden = editor.querySelector('input[name=stype]:checked').value !== 'weekly'; };
    editor.querySelectorAll('input[name=stype]').forEach((r) => r.addEventListener('change', applyType));
    applyType();
    const saveButton = document.getElementById('job-save');
    const form = await specForm(document.getElementById('job-spec'), job ? job.spec : undefined);
    // Another job was opened (or the page left) while the lists loaded: that editor owns the buttons.
    if (!saveButton.isConnected) return;
    document.getElementById('job-cancel').onclick = () => { editor.innerHTML = ''; };
    saveButton.onclick = async (e) => {
      const msg = document.getElementById('job-msg');
      try {
        e.target.disabled = true;
        await api('POST', '/api/jobs', {
          id: job ? job.id : undefined,
          name: document.getElementById('job-name').value,
          spec: form.getSpec(),
          enabled: document.getElementById('job-enabled').checked,
          schedule: {
            type: editor.querySelector('input[name=stype]:checked').value,
            time: document.getElementById('job-time').value,
            days: [...days.querySelectorAll('input:checked')].map((i) => i.value),
          },
        });
        editor.innerHTML = '';
        load();
      } catch (err) {
        msg.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`;
        e.target.disabled = false;
      }
    };
    editor.scrollIntoView({ behavior: 'smooth' });
  };

  document.getElementById('new').onclick = () => openEditor(null);
  load();
}

function testResultHtml(r) {
  const accessible = r.databases.filter((d) => d.hasAccess !== false);
  const noView = accessible.filter((d) => !d.canViewDefinition).length;
  const limited = noView || accessible.length < r.databases.length;
  return `<div class="notice ${limited ? 'warn' : 'ok'}">
    <b>เชื่อมต่อได้</b> &middot; ${esc(r.edition)} ${esc(r.version)} &middot; collation ${esc(r.collation)}<br>
    login: ${esc(r.login)} &middot; เข้าได้ ${accessible.length} จาก ${r.databases.length} ฐาน &middot; VIEW ANY DEFINITION: ${r.viewAnyDefinition ? 'มี' : 'ไม่มี'}
    ${noView ? `<br>ไม่มีสิทธิ์ VIEW DEFINITION ใน ${noView} ฐานที่เข้าได้: ผลเทียบของฐานเหล่านั้นจะไม่ครบ` : ''}</div>`;
}

async function pageServers() {
  $app.innerHTML = `<div class="page-head"><div><h1>Servers</h1>
    <div class="muted">รหัสผ่านของ server ที่สร้างที่นี่เข้ารหัสด้วย Windows DPAPI: เปิดได้เฉพาะ Windows user นี้บนเครื่องนี้</div></div>
    <button class="primary" id="new">เพิ่ม server</button></div><div id="editor"></div><div id="list"><div class="empty"><span class="spinner"></span></div></div>`;
  const listEl = document.getElementById('list');
  const editor = document.getElementById('editor');

  const load = async () => {
    let list;
    try { list = await getServers(true); } catch (err) { return showError(listEl, err); }
    const kindText = { builtin: 'ในตัว', app: 'สร้างที่นี่', mcp: 'mssql-mcp (อ่านอย่างเดียว)' };
    listEl.innerHTML = `<div class="table-wrap"><table><thead><tr><th>ชื่อ</th><th>Address</th><th>Login</th><th>ที่มา</th><th></th></tr></thead><tbody>
      ${list.map((s) => `<tr>
        <td><b>${esc(s.kind === 'builtin' ? 'localhost' : s.name)}</b></td>
        <td class="mono small">${esc(s.port ? `${s.server},${s.port}` : s.server)}</td>
        <td class="small">${s.auth === 'sql' ? `SQL: ${esc(s.user)}` : 'Windows auth'}</td>
        <td class="small">${kindText[s.kind]}</td>
        <td><div class="actions"><button data-test="${esc(s.id)}">ทดสอบ</button>
          ${s.kind === 'app' ? `<button data-edit="${esc(s.id)}">แก้ไข</button><button class="danger" data-delete="${esc(s.id)}">ลบ</button>` : ''}</div></td>
      </tr><tr hidden data-result="${esc(s.id)}"><td colspan="5"></td></tr>`).join('')}</tbody></table></div>
      <p class="hint">profile ของ mssql-mcp อ่านจาก ~/.config/mssql-mcp/*.env (แก้ที่ไฟล์นั้น)</p>`;
    listEl.onclick = async (e) => {
      const test = e.target.closest('[data-test]');
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-delete]');
      if (test) {
        const row = listEl.querySelector(`tr[data-result="${CSS.escape(test.dataset.test)}"]`);
        row.hidden = false;
        row.firstElementChild.innerHTML = '<span class="spinner"></span> กำลังทดสอบ...';
        try { row.firstElementChild.innerHTML = testResultHtml(await getDatabases(test.dataset.test, true)); }
        catch (err) { row.firstElementChild.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
      }
      if (edit) openEditor(list.find((s) => s.id === edit.dataset.edit));
      if (del) armDelete(del, async () => {
        try { await api('DELETE', `/api/servers/${encodeURIComponent(del.dataset.delete)}`); load(); } catch (err) { alertInline(listEl, err); }
      });
    };
  };

  const openEditor = (s) => {
    const v = s || { name: '', server: '', port: 1433, auth: 'sql', user: '', encrypt: true, trustServerCertificate: true };
    editor.innerHTML = `<div class="panel" style="margin-bottom:16px">
      <h2 style="margin-top:0">${s ? 'แก้ไข server' : 'เพิ่ม server'}</h2>
      <div class="grid2">
        <label class="field"><span>ชื่อ (ไว้เรียก)</span><input type="text" id="s-name" value="${esc(v.name)}" placeholder="เช่น test-197"></label>
        <label class="field"><span>Host หรือ IP</span><input type="text" id="s-server" value="${esc(v.server)}" placeholder="192.168.100.197"></label>
        <label class="field"><span>Port</span><input type="number" id="s-port" value="${esc(v.port || '')}" placeholder="1433"></label>
        <label class="field"><span>การยืนยันตัวตน</span><select id="s-auth"><option value="sql"${v.auth === 'sql' ? ' selected' : ''}>SQL login</option><option value="windows"${v.auth === 'windows' ? ' selected' : ''}>Windows auth</option></select></label>
        <label class="field sql-only"><span>User</span><input type="text" id="s-user" value="${esc(v.user)}" autocomplete="off"></label>
        <label class="field sql-only"><span>Password</span><input type="password" id="s-password" autocomplete="new-password" placeholder="${s && s.hasPassword ? 'เว้นว่าง = ใช้รหัสเดิม' : ''}"></label>
      </div>
      <label class="check"><input type="checkbox" id="s-encrypt"${v.encrypt ? ' checked' : ''}>Encrypt connection</label>
      <label class="check"><input type="checkbox" id="s-trust"${v.trustServerCertificate ? ' checked' : ''}>Trust server certificate (self-signed)</label>
      <div id="s-result"></div>
      <div class="row" style="margin-top:12px"><button id="s-test">ทดสอบการเชื่อมต่อ</button><button class="primary" id="s-save">บันทึก</button><button id="s-cancel">ยกเลิก</button><span id="s-msg"></span></div></div>`;
    const auth = document.getElementById('s-auth');
    const applyAuth = () => editor.querySelectorAll('.sql-only').forEach((e) => { e.hidden = auth.value !== 'sql'; });
    auth.addEventListener('change', applyAuth);
    applyAuth();
    const read = () => ({
      id: s ? s.id : undefined,
      name: document.getElementById('s-name').value,
      server: document.getElementById('s-server').value,
      port: document.getElementById('s-port').value,
      auth: auth.value,
      user: document.getElementById('s-user').value,
      password: document.getElementById('s-password').value,
      encrypt: document.getElementById('s-encrypt').checked,
      trustServerCertificate: document.getElementById('s-trust').checked,
    });
    const result = document.getElementById('s-result');
    document.getElementById('s-test').onclick = async (e) => {
      e.target.disabled = true;
      result.innerHTML = '<p><span class="spinner"></span> กำลังทดสอบ...</p>';
      try { result.innerHTML = testResultHtml(await api('POST', '/api/servers/test', read())); }
      catch (err) { result.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
      e.target.disabled = false;
    };
    document.getElementById('s-save').onclick = async (e) => {
      const msg = document.getElementById('s-msg');
      try {
        e.target.disabled = true;
        const saved = await api('POST', '/api/servers', read());
        dbCache.delete(saved.id);
        editor.innerHTML = '';
        load();
      } catch (err) {
        msg.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`;
        e.target.disabled = false;
      }
    };
    document.getElementById('s-cancel').onclick = () => { editor.innerHTML = ''; };
    editor.scrollIntoView({ behavior: 'smooth' });
  };

  document.getElementById('new').onclick = () => openEditor(null);
  load();
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

const PAGES = { compare: pageCompare, history: pageHistory, drift: pageDrift, schedules: pageSchedules, servers: pageServers };

function route() {
  if (activeStream) { activeStream.close(); activeStream = null; }
  const [, page = 'compare', arg] = location.hash.split('/');
  const current = page === 'runs' ? 'history' : page;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === current));
  if (page === 'runs' && arg) return pageRun(arg);
  (PAGES[page] || pageCompare)();
}

window.addEventListener('hashchange', route);
route();
