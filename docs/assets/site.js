const COPY = {
  ko: {
    brandTagline: '상태 유지형 Playwright 자동화',
    navFeatures: '특징',
    navWorkflow: '흐름',
    navGallery: '화면',
    navGuides: '가이드',
    heroEyebrow: '오프라인망 대응 브라우저 제어면',
    heroTitle: 'Playwright 브라우저 자동화를 세션 유지형 REST API와 Streamable MCP로 제공합니다.',
    heroDescription:
      '단일 컨테이너로 배포하고, 호출 사이에 브라우저 상태를 유지하며, 운영자와 AI agent가 같은 자동화 표면을 공유할 수 있습니다.',
    heroPrimaryCta: '최신 릴리즈 받기',
    heroSecondaryCta: 'GitHub 저장소 보기',
    heroPointOne: '오프라인망에 바로 반입 가능한 단일 컨테이너 배포',
    heroPointTwo: 'Runs API, 저수준 Sessions API, Streamable MCP를 한 런타임에 통합',
    heroPointThree: 'Swagger UI, API Playground, 스크린샷, trace, 가이드 뷰어 내장',
    metricRest: '상태 유지형 제어면',
    metricMcp: 'Streamable HTTP 도구',
    metricLlm: '계획 및 스캐폴드 보조',
    metricDocker: '오프라인 배포 패키징',
    heroNoteTitle: '권장 운영 형태',
    heroNoteBody:
      '브라우저 세션은 오래 유지하고, context로 사용자 상태를 격리하고, AI agent는 운영자가 REST로 검증하던 동일한 MCP tool을 호출합니다.',
    featuresEyebrow: '왜 쓰는가',
    featuresTitle: '하나의 런타임으로 세 가지 운영 모드를 지원합니다',
    featureOneTitle: '스크립트 레지스트리와 실행',
    featureOneBody:
      'Playwright spec을 등록하고, 런타임 변수로 실행하며, 리포트, 로그, 스크린샷, trace, video 산출물을 수집합니다.',
    featureTwoTitle: '저수준 세션 제어',
    featureTwoBody:
      '로그인 플로우, 채팅 플로우, flaky UI 상태를 브라우저, context, page 리소스를 유지한 채 단계별로 디버깅합니다.',
    featureThreeTitle: 'AI agent 작성 보조',
    featureThreeBody:
      '자연어 테스트 요청을 plan, scaffold, locator 힌트, MCP tool 호출 순서로 정리해 오프라인 LLM도 따라갈 수 있게 만듭니다.',
    featureFourTitle: '오프라인 배포',
    featureFourBody:
      'Docker 이미지를 tar.gz로 릴리즈하고, 에어갭 환경에 적재한 뒤 Swagger UI, Playground, 데모 페이지를 바로 띄울 수 있습니다.',
    workflowEyebrow: '권장 흐름',
    workflowTitle: '자연어 요청에서 검증된 브라우저 실행까지',
    workflowOneTitle: '계획 수립',
    workflowOneBody:
      'assist API 또는 MCP tool로 요청을 액션, 변수, locator 전략으로 구조화합니다.',
    workflowTwoTitle: '페이지 점검',
    workflowTwoBody:
      '디버그 세션을 열고 heading, locator 후보를 확인한 뒤 최종 스크립트 전 단계에서 다듬습니다.',
    workflowThreeTitle: '실행',
    workflowThreeBody:
      '등록된 spec을 /api/runs 로 실행하면서 project, environment, trace, video, storage state 옵션을 함께 넘깁니다.',
    workflowFourTitle: '리뷰',
    workflowFourBody:
      '같은 API 표면에서 artifacts, logs, report를 확인하거나 이 페이지 안의 가이드를 따라 운영 절차를 검토합니다.',
    galleryEyebrow: '실제 화면',
    galleryTitle: '프로젝트에 포함된 UI를 그대로 확인할 수 있습니다',
    galleryOneTitle: 'Swagger UI',
    galleryOneBody: 'REST 엔드포인트와 요청 형식을 별도 도구 없이 바로 탐색합니다.',
    galleryTwoTitle: 'API Playground',
    galleryTwoBody: '브라우저에서 직접 REST 호출을 보내면서 session ID 흐름을 눈으로 확인합니다.',
    galleryThreeTitle: '다국어 데모 페이지',
    galleryThreeBody: '한국어와 영어를 전환하며 안정적인 locator 기반 자동화를 검증할 수 있습니다.',
    guidesEyebrow: 'Markdown 가이드',
    guidesTitle: '랜딩 페이지 안에서 운영 문서를 바로 읽을 수 있습니다',
    guidesSubtitle:
      '가이드는 Markdown 원문으로 저장되고, 이 페이지 안에서 바로 렌더링됩니다. 필요하면 원본 Markdown 보기로 전환할 수 있습니다.',
    guidesListTitle: '가이드 목록',
    renderedView: '렌더링 보기',
    rawView: '원본 Markdown',
    footerCopy: '오프라인 브라우저 자동화, 사람 중심 디버깅, AI agent 실행을 하나의 표면으로 묶었습니다.',
    loadingGuide: '가이드를 불러오는 중입니다...',
    guideLoaded: 'Markdown 가이드를 페이지 안에서 렌더링했습니다.',
    guideLoadFailed: '가이드를 불러오지 못했습니다.',
    noGuideAvailable: '선택 가능한 가이드가 없습니다.'
  },
  en: {
    brandTagline: 'Stateful Playwright automation',
    navFeatures: 'Features',
    navWorkflow: 'Workflow',
    navGallery: 'Gallery',
    navGuides: 'Guides',
    heroEyebrow: 'Offline-ready browser control plane',
    heroTitle: 'Expose Playwright browser automation through a session-aware REST API and Streamable MCP.',
    heroDescription:
      'Deploy one container, keep browser state warm across calls, and let operators and AI agents share the same automation surface.',
    heroPrimaryCta: 'Get the latest release',
    heroSecondaryCta: 'Open GitHub repository',
    heroPointOne: 'Single-container deployment that fits air-gapped environments',
    heroPointTwo: 'Runs API, low-level Sessions API, and Streamable MCP in one runtime',
    heroPointThree: 'Built-in Swagger UI, API Playground, screenshots, trace, and guide viewer',
    metricRest: 'Stateful control plane',
    metricMcp: 'Streamable HTTP tools',
    metricLlm: 'Planning and scaffold assist',
    metricDocker: 'Offline-ready packaging',
    heroNoteTitle: 'Recommended operating shape',
    heroNoteBody:
      'Keep browser sessions warm, isolate users with contexts, and let AI agents call the exact MCP tools that operators verify through REST.',
    featuresEyebrow: 'Why teams use it',
    featuresTitle: 'One runtime supports three operating modes',
    featureOneTitle: 'Script registry and runs',
    featureOneBody:
      'Register Playwright specs, execute them with runtime variables, and collect reports, logs, screenshots, trace, and video artifacts.',
    featureTwoTitle: 'Low-level session control',
    featureTwoBody:
      'Keep browser, context, and page resources alive while debugging login flows, chat journeys, and flaky UI states step by step.',
    featureThreeTitle: 'AI-agent authoring assist',
    featureThreeBody:
      'Turn natural-language test requests into plans, scaffolds, locator hints, and MCP tool sequences that an offline LLM can follow.',
    featureFourTitle: 'Offline deployment',
    featureFourBody:
      'Release the Docker image as tar.gz, load it into the air-gapped environment, and run Swagger UI, the playground, and demo pages immediately.',
    workflowEyebrow: 'Recommended flow',
    workflowTitle: 'From natural-language request to verified browser execution',
    workflowOneTitle: 'Plan',
    workflowOneBody:
      'Use assist APIs or MCP tools to shape the request into actions, variables, and locator strategies.',
    workflowTwoTitle: 'Inspect',
    workflowTwoBody:
      'Open a debug session, inspect headings and locator candidates, and refine the script before you finalize it.',
    workflowThreeTitle: 'Run',
    workflowThreeBody:
      'Execute the registered spec through /api/runs with project, environment, trace, video, and storage state options.',
    workflowFourTitle: 'Review',
    workflowFourBody:
      'Review artifacts, logs, and reports on the same API surface or follow the operational guides rendered inside this page.',
    galleryEyebrow: 'What it looks like',
    galleryTitle: 'See the actual UI shipped with the project',
    galleryOneTitle: 'Swagger UI',
    galleryOneBody: 'Explore REST endpoints and payload shapes without any extra tooling.',
    galleryTwoTitle: 'API Playground',
    galleryTwoBody: 'Send live REST calls from the browser while keeping session IDs and responses visible.',
    galleryThreeTitle: 'Localized demo page',
    galleryThreeBody: 'Switch between Korean and English while validating stable locator-driven automation.',
    guidesEyebrow: 'Markdown guides',
    guidesTitle: 'Read operational docs without leaving the landing page',
    guidesSubtitle:
      'Guides are stored as Markdown and rendered in place. Switch to raw mode whenever you want to inspect the source directly.',
    guidesListTitle: 'Guide list',
    renderedView: 'Rendered',
    rawView: 'Raw Markdown',
    footerCopy: 'Built for offline browser automation, human debugging, and AI-agent execution on the same surface.',
    loadingGuide: 'Loading guide...',
    guideLoaded: 'Markdown guide rendered in the page.',
    guideLoadFailed: 'Failed to load the guide.',
    noGuideAvailable: 'No guide is available.'
  }
};

const GUIDE_SETS = {
  ko: [
    {
      id: 'quickstart',
      file: './guides/quickstart-ko.md',
      title: '빠른 시작',
      description: '서비스 개요, 진입 URL, 그리고 첫 실행 흐름을 빠르게 확인합니다.'
    },
    {
      id: 'offline',
      file: './guides/offline-deploy-ko.md',
      title: '오프라인 배포',
      description: 'tar.gz 반입, docker load, docker run, 점검 절차를 정리합니다.'
    },
    {
      id: 'api',
      file: './guides/api-workflows-ko.md',
      title: 'REST 워크플로',
      description: 'scripts, runs, sessions, artifacts API를 연결해서 사용하는 예시입니다.'
    },
    {
      id: 'llm',
      file: './guides/llm-mcp-ko.md',
      title: 'LLM + MCP 작성 가이드',
      description: '오프라인 LLM이 자연어 요청을 Playwright 스크립트로 바꾸는 흐름입니다.'
    }
  ],
  en: [
    {
      id: 'quickstart',
      file: './guides/quickstart-en.md',
      title: 'Quick start',
      description: 'Get the service shape, entry URLs, and first execution flow in one pass.'
    },
    {
      id: 'offline',
      file: './guides/offline-deploy-en.md',
      title: 'Offline deployment',
      description: 'Review tar.gz transfer, docker load, docker run, and health checks.'
    },
    {
      id: 'api',
      file: './guides/api-workflows-en.md',
      title: 'REST workflows',
      description: 'Connect scripts, runs, sessions, and artifacts into one usable flow.'
    },
    {
      id: 'llm',
      file: './guides/llm-mcp-en.md',
      title: 'LLM + MCP authoring',
      description: 'Turn natural-language requests into Playwright scripts with offline-friendly assist APIs.'
    }
  ]
};

const state = {
  lang: resolveLanguage(),
  guideId: null,
  viewMode: resolveViewMode(),
  cache: new Map()
};

const elements = {
  guideList: document.querySelector('#guide-list'),
  guideTitle: document.querySelector('#guide-title'),
  guideDescription: document.querySelector('#guide-description'),
  guideStatus: document.querySelector('#guide-status'),
  guideRendered: document.querySelector('#guide-rendered'),
  guideRaw: document.querySelector('#guide-raw'),
  guideLanguageBadge: document.querySelector('#guide-language-badge'),
  langButtons: Array.from(document.querySelectorAll('[data-lang-button]')),
  viewButtons: Array.from(document.querySelectorAll('[data-view-mode]')),
  i18nNodes: Array.from(document.querySelectorAll('[data-i18n]'))
};

initialize();

function initialize() {
  applyLanguageCopy();
  bindEvents();
  const guides = getGuides();
  state.guideId = resolveGuideId(guides);
  renderGuideList();
  setViewMode(state.viewMode, false);
  loadGuide(state.guideId);
}

function bindEvents() {
  elements.langButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const lang = button.dataset.langButton;
      if (lang && lang !== state.lang) {
        state.lang = lang;
        localStorage.setItem('pp-pages-lang', lang);
        applyLanguageCopy();
        const guides = getGuides();
        if (!guides.some((guide) => guide.id === state.guideId)) {
          state.guideId = guides[0]?.id ?? null;
        }
        renderGuideList();
        loadGuide(state.guideId);
      }
    });
  });

  elements.viewButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const viewMode = button.dataset.viewMode;
      if (viewMode) {
        setViewMode(viewMode, true);
      }
    });
  });
}

function resolveLanguage() {
  const url = new URL(window.location.href);
  const langParam = url.searchParams.get('lang');
  if (langParam === 'ko' || langParam === 'en') {
    return langParam;
  }

  const saved = localStorage.getItem('pp-pages-lang');
  if (saved === 'ko' || saved === 'en') {
    return saved;
  }

  return navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

function resolveViewMode() {
  const url = new URL(window.location.href);
  return url.searchParams.get('view') === 'raw' ? 'raw' : 'rendered';
}

function resolveGuideId(guides) {
  const url = new URL(window.location.href);
  const guideParam = url.searchParams.get('guide');
  if (guideParam && guides.some((guide) => guide.id === guideParam)) {
    return guideParam;
  }

  return guides[0]?.id ?? null;
}

function getGuides() {
  return GUIDE_SETS[state.lang] ?? GUIDE_SETS.ko;
}

function getCurrentGuide() {
  return getGuides().find((guide) => guide.id === state.guideId) ?? null;
}

function applyLanguageCopy() {
  const copy = COPY[state.lang];
  document.documentElement.lang = state.lang;
  elements.i18nNodes.forEach((node) => {
    const key = node.dataset.i18n;
    if (key && copy[key]) {
      node.textContent = copy[key];
    }
  });

  elements.langButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.langButton === state.lang);
  });

  elements.guideLanguageBadge.textContent = state.lang.toUpperCase();
  syncUrl();
}

function renderGuideList() {
  const guides = getGuides();
  elements.guideList.innerHTML = '';

  if (!guides.length) {
    elements.guideStatus.textContent = COPY[state.lang].noGuideAvailable;
    return;
  }

  guides.forEach((guide) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'guide-link';
    if (guide.id === state.guideId) {
      button.classList.add('is-active');
    }
    button.innerHTML = `<strong>${escapeHtml(guide.title)}</strong><span>${escapeHtml(guide.description)}</span>`;
    button.addEventListener('click', () => {
      if (guide.id !== state.guideId) {
        loadGuide(guide.id);
      }
    });
    elements.guideList.appendChild(button);
  });
}

function setViewMode(viewMode, updateUrl = true) {
  state.viewMode = viewMode === 'raw' ? 'raw' : 'rendered';
  elements.viewButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.viewMode === state.viewMode);
  });

  const isRaw = state.viewMode === 'raw';
  elements.guideRendered.hidden = isRaw;
  elements.guideRaw.hidden = !isRaw;

  if (updateUrl) {
    syncUrl();
  }
}

async function loadGuide(guideId) {
  state.guideId = guideId;
  renderGuideList();
  syncUrl();

  const guide = getCurrentGuide();
  if (!guide) {
    elements.guideTitle.textContent = COPY[state.lang].noGuideAvailable;
    elements.guideDescription.textContent = '';
    elements.guideStatus.textContent = COPY[state.lang].noGuideAvailable;
    elements.guideRendered.innerHTML = '';
    elements.guideRaw.textContent = '';
    return;
  }

  elements.guideTitle.textContent = guide.title;
  elements.guideDescription.textContent = guide.description;
  elements.guideStatus.textContent = COPY[state.lang].loadingGuide;

  try {
    const raw = await fetchGuideContent(guide.file);
    elements.guideRendered.innerHTML = renderMarkdown(raw);
    elements.guideRaw.textContent = raw;
    elements.guideStatus.textContent = COPY[state.lang].guideLoaded;
  } catch (error) {
    console.error(error);
    elements.guideRendered.innerHTML = '';
    elements.guideRaw.textContent = '';
    elements.guideStatus.textContent = `${COPY[state.lang].guideLoadFailed} ${error.message}`;
  }
}

async function fetchGuideContent(file) {
  if (state.cache.has(file)) {
    return state.cache.get(file);
  }

  const response = await fetch(file, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }

  const raw = await response.text();
  state.cache.set(file, raw);
  return raw;
}

function syncUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('lang', state.lang);
  if (state.guideId) {
    url.searchParams.set('guide', state.guideId);
  }
  if (state.viewMode === 'raw') {
    url.searchParams.set('view', 'raw');
  } else {
    url.searchParams.delete('view');
  }
  history.replaceState({}, '', url);
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const fence = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        fence.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const langClass = language ? ` class="language-${escapeAttribute(language)}"` : '';
      output.push(`<pre><code${langClass}>${escapeHtml(fence.join('\n'))}</code></pre>`);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      output.push(`<h${level}>${parseInline(headingMatch[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      output.push('<hr>');
      index += 1;
      continue;
    }

    if (looksLikeTable(lines, index)) {
      const { html, nextIndex } = consumeTable(lines, index);
      output.push(html);
      index = nextIndex;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const { html, nextIndex } = consumeBlockquote(lines, index);
      output.push(html);
      index = nextIndex;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const { html, nextIndex } = consumeList(lines, index, 'ul');
      output.push(html);
      index = nextIndex;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const { html, nextIndex } = consumeList(lines, index, 'ol');
      output.push(html);
      index = nextIndex;
      continue;
    }

    const { html, nextIndex } = consumeParagraph(lines, index);
    output.push(html);
    index = nextIndex;
  }

  return output.join('\n');
}

function consumeParagraph(lines, startIndex) {
  const parts = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const nextLine = lines[index + 1] ?? '';
    if (!trimmed || isBlockStart(line, nextLine)) {
      break;
    }
    parts.push(trimmed);
    index += 1;
  }

  return {
    html: `<p>${parseInline(parts.join(' '))}</p>`,
    nextIndex: index
  };
}

function consumeList(lines, startIndex, type) {
  const matcher = type === 'ol' ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
  const items = [];
  let index = startIndex;

  while (index < lines.length) {
    const match = lines[index].match(matcher);
    if (!match) {
      break;
    }
    items.push(`<li>${parseInline(match[1].trim())}</li>`);
    index += 1;
  }

  return {
    html: `<${type}>${items.join('')}</${type}>`,
    nextIndex: index
  };
}

function consumeBlockquote(lines, startIndex) {
  const parts = [];
  let index = startIndex;

  while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
    parts.push(lines[index].replace(/^\s*>\s?/, '').trim());
    index += 1;
  }

  return {
    html: `<blockquote>${parts.map((part) => `<p>${parseInline(part)}</p>`).join('')}</blockquote>`,
    nextIndex: index
  };
}

function consumeTable(lines, startIndex) {
  const headerCells = splitTableRow(lines[startIndex]);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  const headerHtml = headerCells.map((cell) => `<th>${parseInline(cell)}</th>`).join('');
  const bodyHtml = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${parseInline(cell)}</td>`).join('')}</tr>`)
    .join('');

  return {
    html: `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`,
    nextIndex: index
  };
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function looksLikeTable(lines, index) {
  const current = lines[index] ?? '';
  const next = lines[index + 1] ?? '';
  return current.includes('|') && /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(next);
}

function isBlockStart(line, nextLine) {
  return (
    /^#{1,6}\s+/.test(line) ||
    /^\s*```/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line) ||
    looksLikeTable([line, nextLine], 0)
  );
}

function parseInline(input) {
  const codeSegments = [];
  const codeTokenized = input.replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE${codeSegments.length}@@`;
    codeSegments.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  let html = escapeHtml(codeTokenized);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const external = /^https?:\/\//.test(url);
    const attrs = external ? ' target="_blank" rel="noreferrer"' : '';
    return `<a href="${escapeAttribute(url)}"${attrs}>${label}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1<em>$2</em>');
  html = html.replace(/@@CODE(\d+)@@/g, (_, index) => codeSegments[Number(index)] ?? '');
  return html;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
