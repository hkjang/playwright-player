const { api, artifactObjectUrl, downloadArtifact, formatMs, formatWhen, onClick, element } = window.PwPlayer;
const CONFIG = window.__PW_PLAYER__.clientConfig;
const COPY = CONFIG.copy;

const statusBox = document.getElementById('statusBox');
const listView = document.getElementById('listView');
const detailView = document.getElementById('detailView');
const runList = document.getElementById('runList');
const detailBody = document.getElementById('detailBody');
const queueSummary = document.getElementById('queueSummary');
const statusFilter = document.getElementById('statusFilter');
const retryBtn = document.getElementById('retryBtn');
const cancelBtn = document.getElementById('cancelBtn');
const deleteBtn = document.getElementById('deleteBtn');

const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];
let currentRunId = null;
let evidenceVersion = 0;
const evidenceObjectUrls = new Set();

function clearEvidencePreviews() {
  evidenceVersion += 1;
  for (const url of evidenceObjectUrls) URL.revokeObjectURL(url);
  evidenceObjectUrls.clear();
}

function setStatus(message, isError) {
  statusBox.hidden = !message;
  statusBox.textContent = message || '';
  statusBox.className = isError ? 'status error' : 'status';
}

window.PwPlayer.onError = (error) => setStatus(error.message, true);

function badge(status) {
  return element('span', { className: 'badge ' + status, textContent: status });
}

function fact(label, value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return element('div', { className: 'fact' }, [
    element('span', { textContent: label }),
    element('strong', { textContent: String(value) }),
  ]);
}

// ---- list ------------------------------------------------------------------

async function showList() {
  currentRunId = null;
  clearEvidencePreviews();
  detailView.hidden = true;
  listView.hidden = false;
  setStatus('');

  const query = statusFilter.value ? '?status=' + encodeURIComponent(statusFilter.value) + '&limit=100' : '?limit=100';
  const [runs, queue] = await Promise.all([
    api('GET', CONFIG.apiBasePath + '/runs' + query),
    api('GET', CONFIG.apiBasePath + '/queue'),
  ]);

  queueSummary.textContent = COPY.queueSummary
    .replace('{queued}', queue.data.queued)
    .replace('{running}', queue.data.running)
    .replace('{limit}', queue.data.maxConcurrentRuns);

  runList.replaceChildren();
  if (!runs.data.runs.length) {
    runList.append(element('p', { className: 'muted', textContent: COPY.listEmpty }));
    return;
  }

  runList.append(element('div', { className: 'col-head' }, [
    element('div', { textContent: COPY.colRun }),
    element('div', { textContent: COPY.colScript }),
    element('div', { textContent: COPY.colStatus }),
    element('div', { textContent: COPY.colDuration }),
    element('div', { textContent: COPY.colStarted }),
    element('div', { textContent: COPY.colTests }),
  ]));

  for (const run of runs.data.runs) {
    const duration = run.startedAt && run.endedAt
      ? new Date(run.endedAt) - new Date(run.startedAt)
      : null;
    const failed = (run.tests || []).filter((test) => test.status === 'failed').length;
    const row = element('button', { type: 'button', className: 'run-row' }, [
      element('code', { textContent: run.runId }),
      element('div', { textContent: run.scriptKey }),
      badge(run.status),
      element('div', { className: 'step-ms', textContent: formatMs(duration) }),
      element('div', { className: 'muted', textContent: formatWhen(run.startedAt || run.queuedAt) }),
      element('div', {
        className: 'muted',
        textContent: run.tests && run.tests.length
          ? `${run.tests.length} / ${failed} ${COPY.testFailed}`
          : '-',
      }),
    ]);
    onClick(row, () => showDetail(run.runId));
    runList.append(row);
  }
}

// ---- detail ----------------------------------------------------------------

function flattenSteps(steps, depth) {
  const out = [];
  for (const step of steps || []) {
    out.push({ step, depth });
    out.push(...flattenSteps(step.steps, depth + 1));
  }
  return out;
}

function renderTest(test) {
  const flat = flattenSteps(test.steps, 0);
  const longest = flat.reduce((max, entry) => Math.max(max, entry.step.durationMs || 0), 0) || 1;

  const block = element('div', { className: 'test-block' }, [
    element('div', { className: 'test-head' }, [
      badge(test.status === 'passed' ? 'completed' : test.status === 'failed' ? 'failed' : 'cancelled'),
      element('strong', { textContent: test.title }),
      element('span', { className: 'muted', textContent: `${test.project || ''} · ${formatMs(test.durationMs)}` }),
    ]),
  ]);

  if (!flat.length) {
    block.append(element('p', { className: 'muted', textContent: COPY.timelineEmpty }));
    return block;
  }

  for (const { step, depth } of flat) {
    const row = element('div', { className: 'step' + (step.error ? ' is-failed' : '') }, [
      element('div', {
        className: 'step-title',
        textContent: ' '.repeat(depth * 2) + (depth ? '└ ' : '') + step.title,
        title: step.title,
      }),
      element('div', { className: 'step-bar' }, [
        element('div', { style: `width:${Math.max(2, Math.round(((step.durationMs || 0) / longest) * 100))}%` }),
      ]),
      element('div', { className: 'step-ms', textContent: formatMs(step.durationMs) }),
    ]);
    block.append(row);
    if (step.error) {
      block.append(element('pre', { className: 'step-error', textContent: step.error }));
    }
  }

  // Slowest steps, so a passing-but-slow run is still readable at a glance.
  const slowest = [...flat]
    .filter((entry) => typeof entry.step.durationMs === 'number')
    .sort((left, right) => right.step.durationMs - left.step.durationMs)
    .slice(0, 3);
  if (slowest.length) {
    block.append(element('div', { className: 'chips' }, [
      element('span', { className: 'muted', textContent: COPY.slowest + ':' }),
      ...slowest.map((entry) => element('span', {
        className: 'chip',
        textContent: `${formatMs(entry.step.durationMs)} · ${entry.step.title}`,
      })),
    ]));
  }

  return block;
}

async function renderEvidence(runId, tests) {
  const version = evidenceVersion;
  const attachments = [];
  for (const test of tests || []) {
    for (const attachment of test.attachments || []) {
      attachments.push({ ...attachment, test: test.title });
    }
  }

  const panel = element('div', { className: 'subpanel' }, [
    element('h3', { textContent: COPY.evidenceTitle }),
  ]);
  if (!attachments.length) {
    panel.append(element('p', { className: 'muted', textContent: COPY.evidenceEmpty }));
    return panel;
  }

  const gallery = element('div', { className: 'evidence' });
  for (const attachment of attachments) {
    const artifactPath = attachment.path.split('/').map(encodeURIComponent).join('/');
    const downloadPath = `${CONFIG.apiBasePath}/runs/${runId}/artifacts/${artifactPath}`;
    const caption = element('figcaption', { textContent: `${attachment.name} · ${attachment.path}` });
    const figure = element('figure', {}, [caption]);

    if ((attachment.contentType || '').startsWith('image/')) {
      const image = element('img', { alt: attachment.name });
      image.addEventListener('error', () => {
        caption.textContent = `${attachment.name} (preview unavailable)`;
      });
      figure.prepend(image);
      // The route needs an Authorization header when API_TOKEN is set, which an
      // <img src> cannot send, so fetch it and preview the blob.
      artifactObjectUrl(downloadPath, true)
        .then((url) => {
          if (version !== evidenceVersion) {
            URL.revokeObjectURL(url);
            return;
          }
          evidenceObjectUrls.add(url);
          image.src = url;
        })
        .catch((error) => { caption.textContent = `${attachment.name}: ${error.message}`; });
    }

    const button = element('button', { type: 'button', className: 'secondary', textContent: COPY.download });
    button.dataset.testid = 'evidence-download';
    onClick(button, () => downloadArtifact(downloadPath, attachment.path.split('/').pop()));
    figure.append(button);
    gallery.append(figure);
  }

  panel.append(gallery);
  return panel;
}

// The diagnosis panel.
//
// A hypothesis from a model is not a finding, so the panel says so on screen
// rather than only in the API payload — someone reading this is deciding what
// to do next, and the distinction is the whole point.
function renderAnalysis(runId, run) {
  const panel = element('div', { className: 'subpanel' }, [
    element('h3', { textContent: COPY.analysisTitle }),
  ]);
  panel.dataset.testid = 'analysis-panel';

  const body = element('div');
  const button = element('button', {
    type: 'button',
    id: 'analyzeBtn',
    className: 'secondary',
    textContent: COPY.analyzeButton,
  });
  button.dataset.testid = 'analyze-run';

  const draw = (analysis, cached) => {
    body.replaceChildren();
    if (!analysis) {
      body.append(element('p', { className: 'muted', textContent: COPY.analysisNone }));
      return;
    }

    if (analysis.status === 'unusable') {
      // Summarising prose into something that reads like a finding would be
      // worse than showing that the answer cannot be used.
      body.append(element('p', { className: 'step-error', textContent: COPY.analysisUnusable }));
      body.append(element('pre', { className: 'log', textContent: analysis.raw || '' }));
    } else {
      body.append(element('p', { textContent: analysis.summary || '' }));
      for (const hypothesis of analysis.hypotheses || []) {
        const item = element('div', { className: 'step' }, [
          element('strong', { textContent: hypothesis.cause || '' }),
          element('div', { className: 'chips' }, [
            element('span', {
              className: 'chip',
              textContent: `${COPY.analysisConfidence}: ${hypothesis.confidence}`,
            }),
            // Each hypothesis names the evidence it rests on, so a reader can
            // go and check it instead of taking the model's word.
            ...(hypothesis.evidence || []).map((line) => element('span', { className: 'chip', textContent: line })),
          ]),
        ]);
        item.dataset.testid = 'analysis-hypothesis';
        body.append(item);
      }
      if ((analysis.suggestedChecks || []).length) {
        body.append(element('h4', { textContent: COPY.analysisChecks }));
        const list = element('ul');
        for (const line of analysis.suggestedChecks) {
          list.append(element('li', { textContent: line }));
        }
        body.append(list);
      }
      if (analysis.needsHuman) {
        const flag = element('p', {
          className: 'step-error',
          textContent: `${COPY.analysisNeedsHuman}${analysis.humanReason ? ` — ${analysis.humanReason}` : ''}`,
        });
        flag.dataset.testid = 'analysis-needs-human';
        body.append(flag);
      }
    }

    const meta = element('p', { className: 'muted' });
    meta.dataset.testid = 'analysis-disclaimer';
    meta.textContent = [
      analysis.model ? `${COPY.analysisModel}: ${analysis.model}` : null,
      cached ? COPY.analysisCached : null,
      analysis.disclaimer,
    ].filter(Boolean).join(' · ');
    body.append(meta);
  };

  onClick(button, async () => {
    setStatus(COPY.analysisRunning, false);
    try {
      const result = await api('POST', `${CONFIG.apiBasePath}/runs/${runId}/analyze`, { refresh: true });
      draw(result.data.analysis, result.data.cached);
      // Set after drawing: api() writes the status line on every call, so
      // reporting first would be overwritten by the request that follows.
      setStatus(COPY.analysisDone, false);
    } catch (error) {
      // "Not configured" is an operator problem with a specific fix, so the
      // message names the variable instead of reading as a server fault.
      const message = error.status === 503 ? COPY.analysisNotConfigured : error.message;
      body.replaceChildren(element('p', { className: 'step-error', textContent: message }));
      setStatus(message, true);
    }
  });

  panel.append(button, body);
  draw(run.analysis, Boolean(run.analysis));
  return panel;
}

async function showDetail(runId) {
  currentRunId = runId;
  clearEvidencePreviews();
  const version = evidenceVersion;
  listView.hidden = true;
  detailView.hidden = false;
  detailBody.replaceChildren();
  setStatus('');

  let run;
  try {
    run = (await api('GET', `${CONFIG.apiBasePath}/runs/${runId}`)).data;
  } catch (error) {
    if (version !== evidenceVersion) return;
    // A 404 is about this run, so it belongs in the panel. Anything else is
    // about the request itself — most often a missing API token — and belongs
    // next to the token field, not buried in a panel the user may not look at.
    const isMissing = error.status === 404;
    detailBody.append(element('p', { className: 'muted', textContent: isMissing ? COPY.notFound : error.message }));
    if (!isMissing) {
      setStatus(error.message, true);
    }
    return;
  }
  if (version !== evidenceVersion) return;

  const isTerminal = TERMINAL.includes(run.status);
  retryBtn.hidden = !isTerminal;
  cancelBtn.hidden = isTerminal;
  deleteBtn.hidden = !isTerminal;

  const duration = run.startedAt && run.endedAt ? new Date(run.endedAt) - new Date(run.startedAt) : null;
  detailBody.append(element('div', { className: 'facts' }, [
    element('div', { className: 'fact' }, [
      element('span', { textContent: COPY.colStatus }),
      badge(run.status),
    ]),
    fact(COPY.colRun, run.runId),
    fact(COPY.colScript, run.scriptKey),
    fact(COPY.colDuration, formatMs(duration)),
    fact(COPY.attempt, run.attempt),
    fact(COPY.exitCode, run.exitCode),
    fact(COPY.queuedAt, formatWhen(run.queuedAt)),
    fact(COPY.startedAt, formatWhen(run.startedAt)),
    fact(COPY.endedAt, formatWhen(run.endedAt)),
    fact(COPY.interruptedReason, run.interruptedReason),
    run.script ? fact(COPY.scriptPin, `${run.script.sha256.slice(0, 12)} · ${run.script.sizeBytes}B`) : null,
  ]));

  if (run.network) {
    const network = element('div', { className: 'subpanel' }, [
      element('h3', { textContent: COPY.networkTitle }),
    ]);
    if (!run.network.enforced) {
      network.append(element('p', { className: 'muted', textContent: COPY.networkNone }));
    } else {
      network.append(element('div', { className: 'chips' }, [
        ...run.network.allowlist.map((entry) => element('span', { className: 'chip', textContent: entry })),
        element('span', {
          className: 'chip',
          textContent: `${COPY.networkBlocked}: ${run.network.blockedRequests || 0}`,
        }),
      ]));
      for (const blocked of run.network.blocked || []) {
        network.append(element('p', { className: 'muted', textContent: `${blocked.method} ${blocked.host}` }));
      }
    }
    detailBody.append(network);
  }

  const timeline = element('div', { className: 'subpanel' }, [
    element('h3', { textContent: COPY.timelineTitle }),
  ]);
  if (!(run.tests || []).length) {
    timeline.append(element('p', { className: 'muted', textContent: COPY.timelineEmpty }));
  } else {
    for (const test of run.tests) {
      timeline.append(renderTest(test));
    }
  }
  detailBody.append(timeline);

  detailBody.append(await renderEvidence(runId, run.tests));

  // Only for a run that actually went wrong: asking why a passing run passed is
  // refused by the API anyway.
  if (isTerminal && (run.status !== 'completed' || (run.tests || []).some((test) => test.status !== 'passed'))) {
    detailBody.append(renderAnalysis(runId, run));
  }

  const logPanel = element('div', { className: 'subpanel' }, [
    element('h3', { textContent: COPY.logsTitle }),
  ]);
  const logToggle = element('button', { type: 'button', id: 'logToggle', className: 'secondary', textContent: COPY.showLogs });
  logToggle.dataset.testid = 'log-toggle';
  const logBox = element('pre', { className: 'log', id: 'logBox', hidden: true });
  onClick(logToggle, async () => {
    if (!logBox.hidden) {
      logBox.hidden = true;
      logToggle.textContent = COPY.showLogs;
      return;
    }
    const logs = await api('GET', `${CONFIG.apiBasePath}/runs/${runId}/logs?limit=2000`);
    logBox.textContent = logs.data.logs.map((entry) => `${entry.ts} ${entry.stream} ${entry.line}`).join('\n')
      || COPY.logsEmpty;
    logBox.hidden = false;
    logToggle.textContent = COPY.hideLogs;
  });
  logPanel.append(logToggle, logBox);
  detailBody.append(logPanel);
}

// ---- actions ---------------------------------------------------------------

onClick('refreshBtn', () => (currentRunId ? showDetail(currentRunId) : showList()));
onClick('backBtn', () => showList());
statusFilter.addEventListener('change', () => showList().catch((error) => setStatus(error.message, true)));

onClick(retryBtn, async () => {
  const created = await api('POST', `${CONFIG.apiBasePath}/runs/${currentRunId}/retry`);
  // showDetail clears the status line, so say what happened after it renders —
  // otherwise the only feedback for a retry is a page that looks unchanged.
  await showDetail(created.data.runId);
  setStatus(`${COPY.retried} ${created.data.runId}`, false);
});

onClick(cancelBtn, async () => {
  await api('POST', `${CONFIG.apiBasePath}/runs/${currentRunId}/cancel`);
  await showDetail(currentRunId);
});

onClick(deleteBtn, async () => {
  if (!window.confirm(COPY.deleteConfirm)) {
    return;
  }
  await api('DELETE', `${CONFIG.apiBasePath}/runs/${currentRunId}`);
  await showList();
});

if (CONFIG.authRequired) {
  setStatus(COPY.authRequiredNotice, false);
}

const initialRunId = new URLSearchParams(window.location.search).get('runId');
(initialRunId ? showDetail(initialRunId) : showList()).catch((error) => setStatus(error.message, true));
