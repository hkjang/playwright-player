import fs from "node:fs/promises";
import path from "node:path";

// Core contracts from Microsoft's @playwright/mcp, including the ref arguments
// shipped with our pinned Playwright and the newer target aliases. Browser state
// belongs to the HTTP MCP session, never to a process-wide "current page".
export function createPlaywrightMcpCompatibility({ sessionManager: manager, ApiError, rootDir }) {
  const states = new WeakMap();
  const string = { type: "string" };
  const boolean = { type: "boolean" };
  const filename = { type: "string", description: "Suggested artifact filename; files stay in the server artifact directory." };
  const element = {
    element: { type: "string", description: "Human-readable element description." },
    ref: { type: "string", description: "Exact element reference from the latest page snapshot." },
    target: { type: "string", description: "Element reference or unique Playwright selector; alias for ref." },
  };
  const targetRequired = [{ required: ["ref"] }, { required: ["target"] }];
  const tools = [];
  const invalid = (message) => new ApiError(400, "INVALID_REQUEST", message);

  function validate(value, schema, label = "arguments") {
    if (schema.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
      for (const key of schema.required || []) if (value[key] === undefined) throw invalid(`${label}.${key} is required`);
      for (const [key, child] of Object.entries(schema.properties || {})) {
        if (value[key] !== undefined) validate(value[key], child, `${label}.${key}`);
      }
    } else if (schema.type === "array") {
      if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
      if (schema.maxItems && value.length > schema.maxItems) throw invalid(`${label} has too many entries`);
      value.forEach((entry, index) => validate(entry, schema.items || {}, `${label}[${index}]`));
    } else if (schema.type === "integer" ? !Number.isInteger(value) : schema.type && typeof value !== schema.type) {
      throw invalid(`${label} must be ${schema.type}`);
    }
    if (typeof value === "number" && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) {
      throw invalid(`${label} is outside the supported range`);
    }
    if (schema.enum && !schema.enum.includes(value)) throw invalid(`${label} must be one of: ${schema.enum.join(", ")}`);
    if (schema.anyOf && !schema.anyOf.some((option) => option.required.every((key) => value[key] !== undefined))) {
      throw invalid(`${label} requires ${schema.anyOf.map((option) => option.required.join(" and ")).join(" or ")}`);
    }
  }

  function stateFor(mcpSession) {
    if (!mcpSession || typeof mcpSession !== "object") throw invalid("An initialized MCP session is required");
    let state = states.get(mcpSession);
    if (!state) {
      state = { queue: Promise.resolve(), pages: new WeakMap(), history: [], pending: new Set(), disposed: false };
      states.set(mcpSession, state);
    }
    return state;
  }

  function enqueue(state, callback) {
    const result = state.queue.then(() => {
      assertActive(state);
      return callback();
    });
    state.queue = result.catch(() => undefined);
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = reject; });
    state.pending.add(cancel);
    return Promise.race([result, cancelled]).finally(() => state.pending.delete(cancel));
  }

  const closedError = () => new ApiError(404, "MCP_SESSION_NOT_FOUND", "MCP session was closed");
  function assertActive(state) {
    if (state.disposed) throw closedError();
  }

  function resetBrowser(state) {
    state.sessionId = state.contextId = state.pageId = undefined;
    state.history = [];
  }

  function livePages(state, session) {
    return [...session.pages.values()].filter((record) => record.contextId === state.contextId && !record.page.isClosed());
  }

  function selectPage(state, record) {
    if (state.pageId === record.pageId) return;
    state.history = state.history.filter((pageId) => pageId !== record.pageId);
    if (state.pageId) state.history.push(state.pageId);
    state.pageId = record.pageId;
  }

  function activePage(state, session) {
    const records = livePages(state, session);
    const liveIds = new Set(records.map((record) => record.pageId));
    state.history = state.history.filter((pageId) => liveIds.has(pageId));
    if (!liveIds.has(state.pageId)) state.pageId = state.history.pop() || records[0]?.pageId;
    return session.pages.get(state.pageId);
  }

  function define(name, description, properties, required, handler, extraSchema = {}) {
    const inputSchema = { type: "object", properties, required, ...extraSchema };
    tools.push({
      name, description, inputSchema,
      handler: (args, _principal, mcpSession) => {
        const state = stateFor(mcpSession);
        return enqueue(state, async () => {
          validate(args, inputSchema);
          return handler(state, args);
        });
      },
    });
  }

  function attachPage(state, record) {
    if (state.pages.has(record.page)) return state.pages.get(record.page);
    const info = { refs: new Set(), requests: [], requestMap: new WeakMap(), navigationSeq: 0 };
    state.pages.set(record.page, info);
    record.page.setDefaultTimeout(5000);
    record.page.setDefaultNavigationTimeout(30000);
    record.page.on("dialog", (dialog) => {
      info.dialog = dialog;
      info.notifyModal?.();
    });
    record.page.on("filechooser", (chooser) => {
      info.fileChooser = chooser;
      info.notifyModal?.();
    });
    record.page.on("request", (request) => {
      const entry = { method: request.method(), url: request.url(), resourceType: request.resourceType() };
      info.requestMap.set(request, entry);
      info.requests.push(entry);
      if (info.requests.length > manager.options.maxEventLogEntries) info.requests.shift();
    });
    record.page.on("response", (response) => {
      const entry = info.requestMap.get(response.request());
      if (entry) entry.status = response.status();
    });
    record.page.on("requestfailed", (request) => {
      const entry = info.requestMap.get(request);
      if (entry) entry.failure = request.failure()?.errorText;
    });
    record.page.on("framenavigated", (frame) => {
      if (frame === record.page.mainFrame()) {
        info.refs.clear();
        info.dialog = info.fileChooser = undefined;
      }
    });
    record.page.on("close", () => {
      info.refs.clear();
      info.dialog = info.fileChooser = undefined;
      const session = manager.sessions.get(record.sessionId);
      if (session && state.sessionId === record.sessionId && state.contextId === record.contextId) activePage(state, session);
    });
    return info;
  }

  async function ensureBrowser(state) {
    assertActive(state);
    const previous = manager.sessions.get(state.sessionId);
    if (state.sessionId && (!previous || previous.status === "disconnected" || !previous.browser.isConnected())) {
      const previousId = state.sessionId;
      resetBrowser(state);
      if (previous) await manager.closeSession(previousId, "disconnected");
      assertActive(state);
    }
    if (!state.sessionId) {
      const session = await manager.createSession();
      if (state.disposed) {
        await manager.closeSession(session.sessionId, "mcp_closed").catch(() => undefined);
        throw closedError();
      }
      state.sessionId = session.sessionId;
    }
    const live = manager.getLiveSession(state.sessionId);
    if (!live.contexts.has(state.contextId)) {
      state.contextId = state.pageId = undefined;
      state.history = [];
      try {
        const context = await manager.createContext(state.sessionId, { dialogPolicy: { action: "ignore" } });
        assertActive(state);
        state.contextId = context.contextId;
        manager.getContextRecord(live, state.contextId).context.on("page", (page) => {
          if (state.disposed || state.sessionId !== live.sessionId || state.contextId !== context.contextId) return;
          const record = live.pages.get(manager.pageLookup.get(page));
          if (record) {
            attachPage(state, record);
            selectPage(state, record);
          }
        });
      } catch (error) {
        if (manager.sessions.has(live.sessionId)) await manager.closeSession(live.sessionId).catch(() => undefined);
        resetBrowser(state);
        throw error;
      }
    }
    return manager.getLiveSession(state.sessionId);
  }

  async function ensurePage(state) {
    const session = await ensureBrowser(state);
    if (!activePage(state, session)) {
      const page = await manager.createPage(state.sessionId, state.contextId);
      assertActive(state);
      selectPage(state, manager.getPageRecord(session, page.pageId));
    }
    const record = manager.getPageRecord(session, state.pageId);
    attachPage(state, record);
    return record;
  }

  function modalResult(record, info) {
    const result = { pageId: record.pageId, url: record.page.url() };
    if (info.dialog) result.dialog = {
      type: info.dialog.type(), message: info.dialog.message(), defaultValue: info.dialog.defaultValue(),
      nextTool: "browser_handle_dialog",
    };
    if (info.fileChooser) result.fileChooser = { multiple: info.fileChooser.isMultiple(), nextTool: "browser_file_upload" };
    return result;
  }

  // A click that opens a prompt cannot finish until a later MCP call answers it.
  // Release the session lock on a modal event so a later call can answer it.
  // The original action may finish afterward; its own command wrapper records
  // the outcome, while the modal handler captures the currently available state.
  async function raceModal(info, callback) {
    const modal = new Promise((resolve) => { info.notifyModal = () => resolve(undefined); });
    const operation = Promise.resolve().then(callback);
    operation.catch(() => undefined);
    try {
      return await Promise.race([operation, modal]);
    } finally {
      info.notifyModal = undefined;
    }
  }

  function selector(info, args, refKey = "ref", targetKey = "target") {
    const value = args[targetKey] ?? args[refKey];
    if (typeof value !== "string" || !value.trim()) throw invalid(`${refKey} or ${targetKey} is required`);
    if (args[refKey] !== undefined || /^(?:f\d+)?e\d+$/.test(value)) {
      if (!info.refs.has(value)) throw new ApiError(400, "STALE_ELEMENT_REFERENCE", `Ref ${value} is not in the current page snapshot. Call browser_snapshot again.`);
      return `aria-ref=${value}`;
    }
    return value;
  }

  async function snapshot(record, info) {
    if (info.dialog || info.fileChooser) return modalResult(record, info);
    // Public locator.ariaSnapshot omits refs in Playwright 1.58.2. Use the same
    // pinned native snapshot API as Microsoft's bundled MCP, including iframes.
    if (typeof record.page._snapshotForAI !== "function") {
      throw new ApiError(501, "SNAPSHOT_UNAVAILABLE", "This Playwright version does not support MCP element references");
    }
    return await raceModal(info, async () => {
      const captured = await record.page._snapshotForAI({ timeout: 5000 });
      info.refs = new Set([...captured.full.matchAll(/\[ref=([^\]]+)\]/g)].map((match) => match[1]));
      return { pageId: record.pageId, url: record.page.url(), title: await record.page.title(), snapshot: captured.full };
    }) ?? modalResult(record, info);
  }

  async function onPage(state, callback, { modal = false, includeSnapshot = true, settlePages = false } = {}) {
    await ensurePage(state);
    return manager.withLock(state.sessionId, async (session) => {
      assertActive(state);
      const record = manager.getPageRecord(session, state.pageId);
      const info = attachPage(state, record);
      if ((info.dialog || info.fileChooser) && !modal) return modalResult(record, info);
      let notifyPage;
      let timer;
      const pageChanged = new Promise((resolve) => { notifyPage = resolve; });
      const context = record.page.context();
      if (settlePages) {
        context.on("page", notifyPage);
        record.page.on("close", notifyPage);
      }
      let output;
      try {
        output = await raceModal(info, () => callback(session, record, info));
        // Playwright may report click completion just before its popup/close
        // event. Give those events a bounded window, without waiting for any
        // external assets or replaying the action.
        if (settlePages && !info.dialog && !info.fileChooser) await Promise.race([
          pageChanged, new Promise((resolve) => { timer = setTimeout(resolve, 250); }),
        ]);
      } finally {
        clearTimeout(timer);
        context.off("page", notifyPage);
        record.page.off("close", notifyPage);
      }
      assertActive(state);
      const active = activePage(state, session);
      return includeSnapshot
        ? { sessionId: session.sessionId, ...output, ...(active ? await snapshot(active, attachPage(state, active)) : { pageId: undefined, closedPageId: record.pageId }) }
        : { sessionId: session.sessionId, ...output };
    });
  }

  function command(session, record, name, args, callback) {
    return manager.runPageCommandLocked(session, record.pageId, name, args, callback);
  }

  async function textArtifact(session, record, name, text, type) {
    if (!name) return {};
    return { artifact: await manager.saveArtifact(session, {
      contextId: record.contextId, pageId: record.pageId, type, extension: "txt", content: text,
      metadata: { filename: path.basename(name) },
    }) };
  }

  define("browser_navigate", "Navigate to a URL in this MCP session's current tab.", { url: string }, ["url"], (state, args) => onPage(state, (session, record, info) => {
    info.navigationSeq = session.eventSeq || 0;
    info.requests = [];
    return manager.navigate(session.sessionId, record.pageId, "goto", { url: args.url, waitUntil: "domcontentloaded" }, session);
  }));
  define("browser_navigate_back", "Go back in the current tab's history.", {}, [], (state) => onPage(state, (session, record, info) => {
    info.navigationSeq = session.eventSeq || 0;
    info.requests = [];
    return manager.navigate(session.sessionId, record.pageId, "goBack", { waitUntil: "domcontentloaded" }, session);
  }));
  define("browser_close", "Close this MCP session's browser. A subsequent call can start a new browser.", {}, [], async (state) => {
    if (!state.sessionId || !manager.sessions.has(state.sessionId)) {
      resetBrowser(state);
      return { status: "closed" };
    }
    const output = await manager.closeSession(state.sessionId);
    resetBrowser(state);
    return output;
  });
  define("browser_snapshot", "Capture an accessibility snapshot with element refs for browser actions.", { filename }, [], (state, args) => onPage(state, (session, record, info) => command(session, record, "browser.snapshot", args, async () => {
    const output = await snapshot(record, info);
    return { ...output, ...await textArtifact(session, record, args.filename, output.snapshot || JSON.stringify(output), "snapshot") };
  }), { includeSnapshot: false }));

  for (const [name, action, properties, required] of [
    ["browser_click", "click", { doubleClick: boolean, button: { type: "string", enum: ["left", "right", "middle"] }, modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"] } } }, []],
    ["browser_hover", "hover", {}, []],
    ["browser_select_option", "selectOption", { values: { type: "array", items: string } }, ["values"]],
  ]) {
    define(name, `${action} on an element from the current page snapshot.`, { ...element, ...properties }, required, (state, args) => onPage(state, (session, record, info) => manager.pageAction(session.sessionId, record.pageId, action, {
      locator: { selector: selector(info, args) }, button: args.button, modifiers: args.modifiers,
      clickCount: args.doubleClick ? 2 : undefined, values: args.values,
    }, session), { settlePages: action === "click" }), { anyOf: targetRequired });
  }
  define("browser_type", "Type text into an editable element, optionally pressing Enter.", { ...element, text: string, submit: boolean, slowly: boolean }, ["text"], (state, args) => onPage(state, (session, record, info) => command(session, record, "browser.type", args, async () => {
    const locator = record.page.locator(selector(info, args));
    if (args.slowly) await locator.pressSequentially(args.text);
    else await locator.fill(args.text);
    if (args.submit) await locator.press("Enter");
    return {};
  }), { settlePages: Boolean(args.submit) }), { anyOf: targetRequired });
  define("browser_press_key", "Press a keyboard key, such as Enter, ArrowLeft, or Control+A.", { key: string }, ["key"], (state, args) => onPage(state, (session, record) => command(session, record, "browser.pressKey", args, async () => {
    await record.page.keyboard.press(args.key);
    return {};
  }), { settlePages: true }));
  define("browser_drag", "Drag from one snapshot element to another.", {
    startElement: string, startRef: string, startTarget: string, endElement: string, endRef: string, endTarget: string,
  }, [], (state, args) => onPage(state, (session, record, info) => manager.pageAction(session.sessionId, record.pageId, "drag", {
    source: { selector: selector(info, args, "startRef", "startTarget") }, target: { selector: selector(info, args, "endRef", "endTarget") },
  }, session)));
  define("browser_fill_form", "Fill multiple form fields from their snapshot references.", { fields: {
    type: "array", maxItems: 100, items: { type: "object", properties: {
      name: string, type: { type: "string", enum: ["textbox", "checkbox", "radio", "combobox", "slider"] }, ref: string, target: string, value: string,
    }, required: ["name", "type", "value"], anyOf: targetRequired },
  } }, ["fields"], (state, args) => onPage(state, (session, record, info) => command(session, record, "browser.fillForm", args, async () => {
    const fields = args.fields.map((field) => ({ ...field, selector: selector(info, field) }));
    for (const field of fields) {
      const locator = record.page.locator(field.selector);
      if (field.type === "checkbox" || field.type === "radio") {
        if (!["true", "false"].includes(field.value)) throw invalid(`${field.name} requires true or false`);
        await locator.setChecked(field.value === "true");
      } else if (field.type === "combobox") await locator.selectOption({ label: field.value });
      else await locator.fill(field.value);
    }
    return {};
  })));
  define("browser_wait_for", "Wait for visible text, text to disappear, or a duration in seconds (up to 30).", {
    time: { type: "number", minimum: 0, maximum: 30 }, text: string, textGone: string,
  }, [], (state, args) => onPage(state, (session, record) => command(session, record, "browser.waitFor", args, async () => {
    if (args.time === undefined && args.text === undefined && args.textGone === undefined) throw invalid("time, text, or textGone is required");
    if (args.time !== undefined) await new Promise((resolve) => setTimeout(resolve, args.time * 1000));
    if (args.text !== undefined) await record.page.getByText(args.text).first().waitFor({ state: "visible" });
    if (args.textGone !== undefined) await record.page.getByText(args.textGone).first().waitFor({ state: "hidden" });
    return {};
  })));
  define("browser_resize", "Resize the browser viewport.", {
    width: { type: "integer", minimum: 1, maximum: 16384 }, height: { type: "integer", minimum: 1, maximum: 16384 },
  }, ["width", "height"], (state, args) => onPage(state, (session, record) => command(session, record, "browser.resize", args, async () => {
    await record.page.setViewportSize({ width: args.width, height: args.height });
    return {};
  })));
  define("browser_evaluate", "Evaluate JavaScript on the page or a snapshot element. Requires ENABLE_EVALUATE.", {
    ...element, function: string, filename,
  }, ["function"], (state, args) => onPage(state, async (session, record, info) => {
    if (!manager.options.enableEvaluate) throw new ApiError(403, "EVALUATE_DISABLED", "page.evaluate is disabled by configuration");
    let output;
    if (args.ref !== undefined || args.target !== undefined) {
      output = await command(session, record, "browser.evaluate", args, async () => {
        const locator = record.page.locator(selector(info, args));
        // The pinned MCP uses this function-string API so user code executes
        // only in the browser, including for elements inside child frames.
        if (typeof locator._evaluateFunction !== "function") throw new ApiError(501, "EVALUATE_UNAVAILABLE", "This Playwright version does not support element function evaluation");
        return { result: await locator._evaluateFunction(args.function) };
      });
    } else output = await manager.pageAction(session.sessionId, record.pageId, "evaluate", { expression: args.function }, session);
    return { ...output, ...await textArtifact(session, record, args.filename, JSON.stringify(output.result, null, 2) ?? "undefined", "evaluation") };
  }, { settlePages: true }));
  define("browser_take_screenshot", "Capture a viewport or element screenshot and return an inline MCP image.", {
    ...element, type: { type: "string", enum: ["png", "jpeg"] }, filename, fullPage: boolean,
    scale: { type: "string", enum: ["css", "device"], default: "css" },
  }, [], (state, args) => onPage(state, (session, record, info) => {
    const locator = args.ref !== undefined || args.target !== undefined ? { selector: selector(info, args) } : undefined;
    if (locator && args.fullPage) throw invalid("fullPage cannot be used with an element screenshot");
    return manager.screenshot(session.sessionId, record.pageId, {
      locator, type: args.type || (/\.jpe?g$/i.test(args.filename || "") ? "jpeg" : "png"),
      fullPage: args.fullPage ?? false, scale: args.scale || "css", filename: args.filename,
    }, session);
  }, { includeSnapshot: false }));

  define("browser_tabs", "List, create, close, or select a browser tab. Tab indexes start at zero.", {
    action: { type: "string", enum: ["list", "new", "close", "select"] }, index: { type: "integer", minimum: 0 }, url: string,
  }, ["action"], async (state, args) => {
    let session = await ensureBrowser(state);
    const records = () => livePages(state, session);
    activePage(state, session);
    if (args.action === "new") {
      const page = await manager.createPage(state.sessionId, state.contextId);
      assertActive(state);
      selectPage(state, manager.getPageRecord(session, page.pageId));
    }
    else if (args.action === "select" || args.action === "close") {
      const record = args.index === undefined && args.action === "close" ? session.pages.get(state.pageId) : records()[args.index];
      if (!record) throw invalid("Tab index does not exist");
      if (args.action === "select") selectPage(state, record);
      else {
        await manager.closePage(state.sessionId, record.pageId);
        activePage(state, session);
      }
    }
    if (args.action === "new" && args.url) {
      await ensurePage(state);
      await onPage(state, (live, record) => manager.navigate(live.sessionId, record.pageId, "goto", { url: args.url, waitUntil: "domcontentloaded" }, live));
    }
    session = manager.getLiveSession(state.sessionId);
    return manager.withLock(state.sessionId, async () => {
      assertActive(state);
      const tabs = await Promise.all(records().map(async (record, index) => {
        const info = attachPage(state, record);
        return { index, pageId: record.pageId, url: record.page.url(), title: info.dialog ? "" : await record.page.title().catch(() => "") };
      }));
      manager.touch(session);
      manager.logAction(session, { type: `browser.tabs.${args.action}`, status: "ok", input: args });
      const active = activePage(state, session);
      return { sessionId: state.sessionId, tabs: tabs.map((tab) => ({ ...tab, current: tab.pageId === active?.pageId })), ...(active ? await snapshot(active, attachPage(state, active)) : {}) };
    });
  });

  define("browser_console_messages", "Return console messages from the current tab.", {
    level: { type: "string", enum: ["error", "warning", "info", "debug"], default: "info" }, all: boolean, filename,
  }, [], (state, args) => onPage(state, (session, record, info) => command(session, record, "browser.consoleMessages", args, async () => {
    const levels = { error: 0, warning: 1, warn: 1, info: 2, log: 2, debug: 3, trace: 3 };
    const threshold = levels[args.level || "info"];
    const messages = session.events.filter((event) => event.pageId === record.pageId
      && (args.all || event.seq > info.navigationSeq) && ["console", "pageerror"].includes(event.type)
      && (event.type === "pageerror" ? 0 : levels[event.level] ?? 2) <= threshold);
    return { messages, ...await textArtifact(session, record, args.filename, JSON.stringify(messages, null, 2), "console") };
  }), { modal: true, includeSnapshot: false }));
  define("browser_network_requests", "Return network requests from the current tab since the last navigation.", {
    includeStatic: boolean, static: boolean, filter: string, filename,
  }, [], (state, args) => onPage(state, (session, record, info) => command(session, record, "browser.networkRequests", args, async () => {
    let filter;
    try { filter = args.filter ? new RegExp(args.filter) : undefined; } catch { throw invalid("filter must be a valid regular expression"); }
    const requests = info.requests.filter((entry) => (args.static ?? args.includeStatic) || entry.failure || !entry.status || entry.status >= 400
      || !["image", "font", "stylesheet", "script", "media"].includes(entry.resourceType)).filter((entry) => !filter || filter.test(entry.url));
    return { requests, ...await textArtifact(session, record, args.filename, JSON.stringify(requests, null, 2), "network") };
  }), { modal: true, includeSnapshot: false }));
  define("browser_handle_dialog", "Accept or dismiss the pending JavaScript dialog.", { accept: boolean, promptText: string }, ["accept"], (state, args) => onPage(state, (session, record, info) => command(session, record, "browser.handleDialog", args, async () => {
    if (!info.dialog) throw invalid("There is no open dialog");
    const dialog = info.dialog;
    info.dialog = undefined;
    if (args.accept) await dialog.accept(args.promptText);
    else await dialog.dismiss();
    return { handled: true };
  }), { modal: true, settlePages: true }));
  define("browser_file_upload", "Set files in the pending file chooser. Paths must be inside the project, scripts, or artifacts directory; omit paths to cancel.", {
    paths: { type: "array", items: string, maxItems: 100 },
  }, [], (state, args) => onPage(state, (session, record, info) => command(session, record, "browser.fileUpload", args, async () => {
    if (!info.fileChooser) throw invalid("There is no open file chooser. Click a file input first.");
    if (args.paths === undefined) {
      info.fileChooser = undefined;
      return { cancelled: true };
    }
    const roots = await Promise.all([rootDir, manager.options.scriptsDir, manager.options.artifactsDir].filter(Boolean).map((directory) => fs.realpath(directory)));
    const paths = await Promise.all(args.paths.map(async (file) => {
      const absolute = await fs.realpath(path.resolve(rootDir, file));
      if (!roots.some((root) => {
        const relative = path.relative(root, absolute);
        return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      })) throw new ApiError(403, "FILE_NOT_ALLOWED", "Upload paths must stay inside the project, scripts, or artifacts directory");
      if (!(await fs.stat(absolute)).isFile()) throw invalid("Upload paths must name regular files");
      return absolute;
    }));
    const chooser = info.fileChooser;
    await chooser.setFiles(paths);
    info.fileChooser = undefined;
    return { uploaded: paths.length };
  }), { modal: true }));

  return {
    tools,
    dispose: async (mcpSession) => {
      const state = states.get(mcpSession);
      if (!state) return;
      if (state.disposed) return state.disposal;
      state.disposed = true;
      for (const cancel of state.pending) cancel(closedError());
      const sessionId = state.sessionId;
      resetBrowser(state);
      // Closing the browser interrupts unresolved evaluate/navigation calls.
      // It must not queue behind the very operation it needs to interrupt.
      state.disposal = sessionId && manager.sessions.has(sessionId)
        ? manager.closeSession(sessionId, "mcp_closed") : Promise.resolve();
      return state.disposal;
    },
  };
}
