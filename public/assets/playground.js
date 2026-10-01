const CONFIG = window.__PW_PLAYER__.clientConfig;
const COPY = CONFIG.copy;
const state = { sessionId: '', contextId: '', pageId: '' };
const resultBox = document.getElementById('resultBox');
const preview = document.getElementById('preview');
const statusBox = document.getElementById('statusBox');
const scriptKeySelect = document.getElementById('scriptKey');
const sessionIdInput = document.getElementById('sessionId');
const contextIdInput = document.getElementById('contextId');
const pageIdInput = document.getElementById('pageId');

function setStatus(message, isError) {
  statusBox.textContent = message;
  statusBox.className = isError ? 'status error' : 'status';
}

function setResult(payload) {
  resultBox.textContent = JSON.stringify(payload, null, 2);
}

function syncInputs() {
  sessionIdInput.value = state.sessionId;
  contextIdInput.value = state.contextId;
  pageIdInput.value = state.pageId;
}

// <img src> and <a href> cannot carry an Authorization header, so with
// API_TOKEN set both have to go through fetch and a blob URL.
async function fetchArtifactBlob(downloadPath, inline) {
  const url = downloadPath + (inline ? '?disposition=inline' : '');
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    throw new Error(COPY.requestFailed + ' (' + response.status + ')');
  }
  return URL.createObjectURL(await response.blob());
}

async function downloadArtifact(artifact) {
  const objectUrl = await fetchArtifactBlob(artifact.downloadPath, false);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = artifact.fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 30000);
}

function showArtifact(artifact) {
  if (!artifact || !artifact.downloadPath) {
    preview.textContent = COPY.noScreenshot;
    return;
  }
  preview.replaceChildren();
  const image = document.createElement('img');
  image.alt = COPY.screenshotAlt;
  preview.append(image);
  fetchArtifactBlob(artifact.downloadPath, true)
    .then(function (objectUrl) { image.src = objectUrl; })
    .catch(function (error) { preview.textContent = error.message; });
}

function authHeaders() {
  const token = (document.getElementById('apiToken').value || '').trim();
  return token ? { Authorization: 'Bearer ' + token } : {};
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: Object.assign({}, body ? { 'Content-Type': 'application/json' } : {}, authHeaders()),
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  setResult(payload);
  if (!response.ok) {
    const message = payload && payload.error && payload.error.message ? payload.error.message : COPY.requestFailed;
    setStatus(method + ' ' + path + ' ' + COPY.failed + ': ' + message, true);
    throw new Error(message);
  }
  setStatus(method + ' ' + path + ' ' + COPY.completed, false);
  return payload;
}

async function refreshScripts() {
  const payload = await api('GET', CONFIG.apiBasePath + '/scripts');
  const scripts = (payload.data && payload.data.scripts) || [];
  scriptKeySelect.innerHTML = '';
  if (!scripts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = COPY.noScripts;
    scriptKeySelect.append(option);
    return;
  }
  scripts.forEach((script) => {
    const option = document.createElement('option');
    option.value = script.scriptKey;
    option.textContent = script.scriptKey;
    scriptKeySelect.append(option);
  });
}

function requireValue(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

// Without this, an early throw (missing session id, invalid JSON) left the
// page looking like the click did nothing at all.
function onClick(id, handler) {
  const element = document.getElementById(id);
  if (!element) {
    return;
  }
  element.addEventListener('click', async () => {
    element.disabled = true;
    try {
      await handler();
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      element.disabled = false;
    }
  });
}

onClick('healthBtn', async () => { await api('GET', '/health'); });
onClick('syncScriptsBtn', async () => {
  await api('POST', CONFIG.apiBasePath + '/scripts/sync', {});
  await refreshScripts();
});
onClick('loadScriptsBtn', async () => { await refreshScripts(); });
onClick('createRunBtn', async () => {
  const variablesText = document.getElementById('variablesJson').value.trim();
  let variables = {};
  try {
    variables = variablesText ? JSON.parse(variablesText) : {};
  } catch (error) {
    throw new Error(COPY.invalidVariablesJson + ' ' + error.message);
  }
  const payload = await api('POST', CONFIG.apiBasePath + '/runs', {
    scriptKey: scriptKeySelect.value,
    project: document.getElementById('project').value.trim() || undefined,
    env: document.getElementById('envName').value.trim() || undefined,
    baseURL: document.getElementById('baseUrl').value.trim() || undefined,
    grep: document.getElementById('grep').value.trim() || undefined,
    storageStateRef: document.getElementById('storageStateRef').value.trim() || undefined,
    variables
  });
  if (payload && payload.data && payload.data.runId) {
    setStatus(COPY.runCreated + ' ' + payload.data.runId, false);
  }
});
onClick('listRunsBtn', async () => { await api('GET', CONFIG.apiBasePath + '/runs'); });
onClick('createSessionBtn', async () => {
  const payload = await api('POST', CONFIG.apiBasePath + '/sessions', { browserType: 'chromium', headless: true });
  state.sessionId = payload.data.sessionId;
  state.contextId = '';
  state.pageId = '';
  syncInputs();
});
onClick('createContextBtn', async () => {
  requireValue(state.sessionId, COPY.createSessionFirst);
  const payload = await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/contexts', {
    viewport: { width: 1440, height: 960 },
    locale: CONFIG.language === 'ko' ? 'ko-KR' : 'en-US'
  });
  state.contextId = payload.data.contextId;
  state.pageId = '';
  syncInputs();
});
onClick('createPageBtn', async () => {
  requireValue(state.contextId, COPY.createContextFirst);
  const payload = await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/contexts/' + state.contextId + '/pages', {});
  state.pageId = payload.data.pageId;
  syncInputs();
});
onClick('gotoDemoBtn', async () => {
  requireValue(state.pageId, COPY.createPageFirst);
  await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/goto', {
    url: window.location.origin + CONFIG.demoPath,
    waitUntil: 'domcontentloaded'
  });
});
onClick('clickPrimaryBtn', async () => {
  requireValue(state.pageId, COPY.createPageFirst);
  await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/click', {
    locator: { testId: 'primary-action' }
  });
  await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/assert/text', {
    locator: { testId: 'status' },
    value: COPY.demoPrimaryExpected,
    match: 'contains'
  });
});
onClick('sendMessageBtn', async () => {
  requireValue(state.pageId, COPY.createPageFirst);
  await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/fill', {
    locator: { testId: 'message-input' },
    value: document.getElementById('messageText').value
  });
  await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/click', {
    locator: { testId: 'send-message' }
  });
  await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/assert/text', {
    locator: { testId: 'status' },
    value: COPY.demoMessageSentExpected,
    match: 'contains'
  });
});
onClick('takeScreenshotBtn', async () => {
  requireValue(state.pageId, COPY.createPageFirst);
  const payload = await api('POST', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/pages/' + state.pageId + '/screenshot', {
    fullPage: true,
    type: 'png'
  });
  showArtifact(payload && payload.data && payload.data.artifact);
});
onClick('closeSessionBtn', async () => {
  requireValue(state.sessionId, COPY.createSessionFirst);
  await api('DELETE', CONFIG.apiBasePath + '/sessions/' + state.sessionId);
  state.sessionId = '';
  state.contextId = '';
  state.pageId = '';
  syncInputs();
  preview.textContent = COPY.noScreenshot;
});

onClick('listArtifactsBtn', async () => {
  requireValue(state.sessionId, COPY.createSessionFirst);
  const payload = await api('GET', CONFIG.apiBasePath + '/sessions/' + state.sessionId + '/artifacts');
  const list = document.getElementById('artifactList');
  const artifacts = payload && payload.data && payload.data.artifacts;
  if (!artifacts || !artifacts.length) {
    list.replaceChildren();
    const empty = document.createElement('em');
    empty.textContent = COPY.noArtifacts;
    list.append(empty);
    return;
  }
  list.replaceChildren();
  artifacts.forEach(function(a) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;padding:8px;border-radius:10px;background:rgba(15,118,110,0.06);';
    const type = document.createElement('strong');
    type.textContent = a.type || 'file';
    const meta = document.createElement('span');
    meta.style.cssText = 'color:#5f6b82;font-size:.9rem;';
    meta.textContent = a.fileName + ' (' + Math.round((a.sizeBytes || 0) / 1024) + ' KB)';
    const link = document.createElement('button');
    link.type = 'button';
    link.textContent = COPY.downloadLabel;
    link.style.cssText = 'margin-left:auto;padding:6px 12px;border-radius:999px;background:#0f766e;color:#fff;border:0;font-size:.85rem;font-weight:600;cursor:pointer;';
    link.addEventListener('click', function () {
      downloadArtifact(a).catch(function (error) { setStatus(error.message, true); });
    });
    row.append(type, meta, link);
    list.append(row);
  });
});

syncInputs();
if (CONFIG.authRequired) {
  setStatus(COPY.authRequiredNotice, false);
}
refreshScripts().catch((error) => setStatus(error.message, true));
