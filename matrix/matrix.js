const params = new URLSearchParams(location.search);
const HOST = params.get('host');
document.getElementById('orgHost').textContent = HOST || '';

const NS = 'http://soap.sforce.com/2006/04/metadata';

const state = {
  activeTab: 'labels',
  languages: [],          // e.g. ['fr', 'ja', 'de']
  labels: [],             // from Tooling API - base/default values
  rules: [],              // from Tooling API - base/default values
  translationDocs: {},    // lang -> XMLDocument (parsed Translations file)
  edits: new Map(),       // key `${type}|${lang}|${name}` -> new value
};

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ host: HOST, ...msg }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || 'Unknown error'));
      resolve(res.data);
    });
  });
}

// ---------- XML helpers ----------
function parseDoc(xml) {
  return new DOMParser().parseFromString(xml, 'text/xml');
}
function serializeDoc(doc) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(doc);
}
function emptyTranslationsDoc() {
  return parseDoc(`<Translations xmlns="${NS}"></Translations>`);
}
function readEntries(doc, tag, keyTag, valueTag) {
  const map = {};
  Array.from(doc.getElementsByTagNameNS(NS, tag)).forEach((node) => {
    const key = node.getElementsByTagNameNS(NS, keyTag)[0]?.textContent;
    const val = node.getElementsByTagNameNS(NS, valueTag)[0]?.textContent || '';
    if (key) map[key] = val;
  });
  return map;
}
function writeEntry(doc, tag, keyTag, valueTag, key, value) {
  const existing = Array.from(doc.getElementsByTagNameNS(NS, tag)).find(
    (n) => n.getElementsByTagNameNS(NS, keyTag)[0]?.textContent === key
  );
  if (existing) {
    let valEl = existing.getElementsByTagNameNS(NS, valueTag)[0];
    if (!valEl) {
      valEl = doc.createElementNS(NS, valueTag);
      existing.appendChild(valEl);
    }
    valEl.textContent = value;
  } else {
    const node = doc.createElementNS(NS, tag);
    const keyEl = doc.createElementNS(NS, keyTag);
    keyEl.textContent = key;
    const valEl = doc.createElementNS(NS, valueTag);
    valEl.textContent = value;
    node.appendChild(keyEl);
    node.appendChild(valEl);
    doc.documentElement.appendChild(node);
  }
}

// ---------- Data loading ----------
async function loadAll() {
  const loadingEl = document.getElementById('loading');
  try {
    state.languages = await send({ type: 'LIST_LANGUAGES' });
    const [labels, rules] = await Promise.all([
      send({ type: 'GET_LABELS' }),
      send({ type: 'GET_VALIDATION_RULES' }),
    ]);
    state.labels = labels;
    state.rules = rules;

    if (state.languages.length) {
      const xmlByLang = await send({ type: 'RETRIEVE_TRANSLATIONS', languages: state.languages });
      for (const [lang, xml] of Object.entries(xmlByLang)) {
        state.translationDocs[lang] = xml ? parseDoc(xml) : emptyTranslationsDoc();
      }
    }
    // Ensure every discovered language has a doc even if the retrieve returned nothing for it
    state.languages.forEach((l) => {
      if (!state.translationDocs[l]) state.translationDocs[l] = emptyTranslationsDoc();
    });

    loadingEl.hidden = true;
    render();
  } catch (e) {
    loadingEl.textContent = `Failed to load: ${e.message}`;
  }
}

// ---------- Rendering ----------
function currentRows() {
  if (state.activeTab === 'labels') {
    return state.labels.map((l) => ({ type: 'labels', key: l.Name, name: l.Name, base: l.Value }));
  }
  return state.rules.map((r) => ({
    type: 'rules',
    key: `${r.EntityDefinition?.QualifiedApiName || ''}.${r.ValidationName}`,
    name: `${r.EntityDefinition?.QualifiedApiName || ''}.${r.ValidationName}`,
    base: r.ErrorMessage,
  }));
}

function translatedValue(type, lang, key) {
  const editKey = `${type}|${lang}|${key}`;
  if (state.edits.has(editKey)) return state.edits.get(editKey);
  const doc = state.translationDocs[lang];
  if (!doc) return '';
  const map =
    type === 'labels'
      ? readEntries(doc, 'customLabels', 'name', 'label')
      : readEntries(doc, 'validationRules', 'name', 'errorMessage');
  return map[key] || '';
}

function render() {
  const filter = document.getElementById('search').value.trim().toLowerCase();
  const rows = currentRows().filter((r) => r.name.toLowerCase().includes(filter));

  const table = document.getElementById('grid');
  table.hidden = false;
  table.innerHTML = '';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.innerHTML =
    `<th class="name-col">${state.activeTab === 'labels' ? 'Label Name' : 'Object.Rule'}</th>` +
    `<th>Default</th>` +
    state.languages.map((l) => `<th>${l}</th>`).join('');
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.className = 'name-cell';
    nameTd.textContent = row.name;
    nameTd.title = row.name;
    tr.appendChild(nameTd);

    const baseTd = document.createElement('td');
    const baseInput = document.createElement('input');
    baseInput.className = 'cell-input';
    baseInput.value = row.base || '';
    baseInput.disabled = true;
    baseInput.title = 'Default language value (read-only here; edit via the label/rule itself)';
    baseTd.appendChild(baseInput);
    tr.appendChild(baseTd);

    state.languages.forEach((lang) => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.className = 'cell-input';
      input.value = translatedValue(row.type, lang, row.key);
      const editKey = `${row.type}|${lang}|${row.key}`;
      if (state.edits.has(editKey)) input.classList.add('dirty');
      input.addEventListener('input', () => {
        state.edits.set(editKey, input.value);
        input.classList.add('dirty');
        updateSaveBar();
      });
      td.appendChild(input);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  updateSaveBar();
}

function updateSaveBar() {
  const bar = document.getElementById('savebar');
  const count = state.edits.size;
  bar.hidden = count === 0;
  document.getElementById('diffCount').textContent = `${count} unsaved change${count === 1 ? '' : 's'}`;
}

// ---------- Save / discard ----------
async function saveChanges() {
  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Deploying…';
  try {
    const touchedLangs = new Set(Array.from(state.edits.keys()).map((k) => k.split('|')[1]));
    for (const [key, value] of state.edits.entries()) {
      const [type, lang, name] = key.split('|');
      const doc = state.translationDocs[lang];
      if (type === 'labels') writeEntry(doc, 'customLabels', 'name', 'label', name, value);
      else writeEntry(doc, 'validationRules', 'name', 'errorMessage', name, value);
    }
    const edited = {};
    touchedLangs.forEach((lang) => (edited[lang] = serializeDoc(state.translationDocs[lang])));

    const result = await send({ type: 'DEPLOY_TRANSLATIONS', edited });
    if (result.success) {
      state.edits.clear();
      render();
    } else {
      alert(`Deploy failed:\n${(result.errors || []).join('\n')}`);
    }
  } catch (e) {
    alert(`Deploy failed: ${e.message}`);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save changes';
  }
}

function discardChanges() {
  state.edits.clear();
  render();
}

// ---------- Wire up ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeTab = btn.dataset.tab;
    render();
  });
});
document.getElementById('search').addEventListener('input', render);
document.getElementById('saveBtn').addEventListener('click', saveChanges);
document.getElementById('discardBtn').addEventListener('click', discardChanges);

loadAll();
