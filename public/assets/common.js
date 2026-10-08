// Shared by the playground and the runs pages. No bundler here, so this attaches
// one namespace to window and the page scripts read it.
(function () {
  const bootstrap = window.__PW_PLAYER__ || {};

  function tokenValue() {
    const field = document.getElementById('apiToken');
    return field ? (field.value || '').trim() : '';
  }

  function authHeaders() {
    const token = tokenValue();
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  // Every call goes through here so a page never has to remember the token.
  async function api(method, path, body) {
    const response = await fetch(path, {
      method,
      headers: Object.assign({}, body === undefined ? {} : { 'Content-Type': 'application/json' }, authHeaders()),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      const message = payload && payload.error && payload.error.message
        ? payload.error.message
        : method + ' ' + path + ' failed (' + response.status + ')';
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  // <img src> and <a href> cannot carry an Authorization header, so an artifact
  // has to be fetched and turned into a blob URL when a token is in play.
  async function artifactObjectUrl(downloadPath, inline) {
    const url = new URL(downloadPath, window.location.href);
    if (inline) url.searchParams.set('disposition', 'inline');
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error?.message || 'artifact fetch failed (' + response.status + ')');
    }
    return URL.createObjectURL(await response.blob());
  }

  async function downloadArtifact(downloadPath, fileName) {
    const objectUrl = await artifactObjectUrl(downloadPath, false);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName || '';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 30000);
  }

  function formatMs(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '-';
    }
    if (value < 1000) {
      return Math.round(value) + 'ms';
    }
    return (value / 1000).toFixed(value < 10000 ? 2 : 1) + 's';
  }

  function formatWhen(iso) {
    if (!iso) {
      return '-';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
  }

  // Wraps a click handler so an early throw shows up instead of looking like the
  // button did nothing.
  function onClick(target, handler) {
    const element = typeof target === 'string' ? document.getElementById(target) : target;
    if (!element) {
      return;
    }
    element.addEventListener('click', async function (event) {
      element.disabled = true;
      try {
        await handler(event);
      } catch (error) {
        if (typeof window.PwPlayer.onError === 'function') {
          window.PwPlayer.onError(error);
        } else {
          console.error(error);
        }
      } finally {
        element.disabled = false;
      }
    });
  }

  function element(tag, props, children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      node.append(child);
    }
    return node;
  }

  window.PwPlayer = {
    bootstrap,
    authHeaders,
    api,
    artifactObjectUrl,
    downloadArtifact,
    formatMs,
    formatWhen,
    onClick,
    element,
    onError: null,
  };
}());
