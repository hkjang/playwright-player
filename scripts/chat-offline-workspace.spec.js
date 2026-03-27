import { expect, test } from "@playwright/test";
import { attachHtml, attachScreenshot } from "./helpers.js";

test("offline chat workspace supports channels, thread, and send flow", async ({ page }, testInfo) => {
  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Offline Chat Workspace</title>
        <style>
          :root {
            --bg: #ecf2ff;
            --panel: #ffffff;
            --ink: #182033;
            --muted: #6b748b;
            --line: #d8def0;
            --accent: #1358d4;
            --accent-soft: #e4edff;
            --sidebar: #16213a;
            --thread: #f7faff;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            min-height: 100vh;
            font-family: "Segoe UI", sans-serif;
            color: var(--ink);
            background: radial-gradient(circle at top, #ffffff 0%, #e8f0ff 55%, #d9e4fb 100%);
          }
          .login-shell, .workspace {
            width: min(1220px, calc(100vw - 48px));
            margin: 24px auto;
            border-radius: 28px;
            overflow: hidden;
            border: 1px solid rgba(255,255,255,0.65);
            background: rgba(255,255,255,0.86);
            backdrop-filter: blur(16px);
            box-shadow: 0 28px 70px rgba(20, 33, 58, 0.16);
          }
          .login-shell {
            display: grid;
            grid-template-columns: 1.2fr 1fr;
            min-height: 720px;
          }
          .hero {
            padding: 48px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            color: white;
            background: linear-gradient(145deg, #15203a 0%, #24458c 55%, #2d6bd4 100%);
          }
          .hero h1 {
            margin: 0 0 16px;
            font-size: 52px;
            line-height: 1.03;
            letter-spacing: -0.04em;
          }
          .hero p { margin: 0; max-width: 34ch; font-size: 18px; color: rgba(255,255,255,0.82); }
          .metric-grid { display: grid; gap: 14px; }
          .metric {
            padding: 18px;
            border-radius: 18px;
            background: rgba(255,255,255,0.12);
            border: 1px solid rgba(255,255,255,0.18);
          }
          .metric strong { display: block; margin-bottom: 6px; }
          .login-panel {
            padding: 56px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            gap: 20px;
          }
          .eyebrow {
            color: var(--accent);
            font-size: 12px;
            font-weight: 800;
            letter-spacing: 0.1em;
            text-transform: uppercase;
          }
          .login-panel h2 { margin: 0; font-size: 34px; letter-spacing: -0.03em; }
          .login-panel p { margin: 0; color: var(--muted); }
          label { display: grid; gap: 8px; font-weight: 600; }
          input, textarea {
            width: 100%;
            border: 1px solid var(--line);
            border-radius: 14px;
            padding: 14px 16px;
            font: inherit;
            background: white;
          }
          textarea { resize: none; min-height: 96px; }
          button {
            border: 0;
            border-radius: 14px;
            padding: 13px 18px;
            font: inherit;
            font-weight: 700;
            cursor: pointer;
          }
          .primary { background: var(--accent); color: white; }
          .ghost { background: var(--accent-soft); color: var(--accent); }
          .workspace {
            display: none;
            min-height: 860px;
            grid-template-columns: 280px minmax(0, 1fr) 330px;
          }
          .sidebar {
            background: linear-gradient(180deg, #10192c 0%, #19294a 100%);
            color: white;
            padding: 26px 20px;
            display: grid;
            grid-template-rows: auto auto 1fr auto;
            gap: 18px;
          }
          .brand {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
          }
          .brand-title { font-size: 22px; font-weight: 800; }
          .brand-sub { color: rgba(255,255,255,0.58); font-size: 13px; }
          .badge-box {
            width: 42px;
            height: 42px;
            border-radius: 15px;
            background: rgba(255,255,255,0.14);
            display: grid;
            place-items: center;
            font-weight: 800;
          }
          .status-pill {
            width: fit-content;
            padding: 8px 12px;
            border-radius: 999px;
            background: rgba(83, 228, 169, 0.18);
            color: #95ffd1;
            font-size: 13px;
          }
          .section-title {
            color: rgba(255,255,255,0.54);
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            margin-bottom: 10px;
          }
          .channels { display: grid; gap: 6px; }
          .channel-button {
            display: grid;
            grid-template-columns: auto 1fr auto;
            gap: 10px;
            align-items: center;
            padding: 12px;
            border-radius: 14px;
            color: inherit;
            background: transparent;
          }
          .channel-button.active { background: rgba(255,255,255,0.12); }
          .count-pill {
            min-width: 24px;
            padding: 4px 8px;
            border-radius: 999px;
            background: rgba(255,255,255,0.12);
            text-align: center;
            font-size: 12px;
          }
          .profile {
            display: grid;
            grid-template-columns: auto 1fr auto;
            align-items: center;
            gap: 12px;
            padding: 14px;
            border-radius: 18px;
            background: rgba(255,255,255,0.08);
          }
          .avatar {
            width: 42px;
            height: 42px;
            border-radius: 16px;
            display: grid;
            place-items: center;
            background: #dbe5ff;
            color: #15326a;
            font-weight: 800;
          }
          .main {
            display: grid;
            grid-template-rows: auto 1fr auto;
            background: rgba(255,255,255,0.76);
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 16px;
            padding: 28px 28px 18px;
            border-bottom: 1px solid var(--line);
          }
          .header h3 { margin: 0; font-size: 26px; letter-spacing: -0.03em; }
          .subhead { color: var(--muted); font-size: 14px; }
          .search-pill {
            min-width: 280px;
            padding: 10px 14px;
            border-radius: 999px;
            background: white;
            border: 1px solid var(--line);
            color: var(--muted);
          }
          .messages {
            padding: 18px 28px 0;
            overflow: auto;
            display: grid;
            gap: 14px;
            align-content: start;
          }
          .day-stamp {
            justify-self: center;
            padding: 8px 14px;
            border-radius: 999px;
            background: rgba(19,88,212,0.08);
            color: var(--accent);
            font-size: 12px;
            font-weight: 700;
          }
          .message-card {
            display: grid;
            grid-template-columns: auto 1fr;
            gap: 12px;
            padding: 14px;
            border-radius: 18px;
            background: white;
            border: 1px solid rgba(24,32,51,0.06);
            cursor: pointer;
          }
          .message-card.self { margin-left: 52px; }
          .message-meta {
            display: flex;
            align-items: baseline;
            gap: 10px;
          }
          .message-meta strong { font-size: 15px; }
          .message-meta span { font-size: 12px; color: var(--muted); }
          .message-body { margin-top: 6px; line-height: 1.55; }
          .chip-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
          .chip {
            padding: 7px 10px;
            border-radius: 999px;
            background: #f1f5fd;
            color: #45536d;
            font-size: 12px;
            font-weight: 700;
          }
          .composer {
            padding: 18px 28px 28px;
            display: grid;
            gap: 12px;
          }
          .composer-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
          }
          .typing { font-size: 13px; color: var(--muted); }
          .thread {
            display: grid;
            grid-template-rows: auto 1fr auto;
            background: var(--thread);
            border-left: 1px solid var(--line);
          }
          .thread-header {
            padding: 28px 22px 18px;
            border-bottom: 1px solid var(--line);
          }
          .thread-header h4 { margin: 0 0 8px; font-size: 20px; }
          .thread-feed {
            padding: 18px 22px 0;
            overflow: auto;
            display: grid;
            gap: 12px;
            align-content: start;
          }
          .thread-item {
            padding: 14px;
            border-radius: 16px;
            background: white;
            border: 1px solid rgba(24,32,51,0.06);
          }
          .thread-item strong { display: block; margin-bottom: 6px; }
          .thread-compose {
            padding: 18px 22px 24px;
            display: grid;
            gap: 10px;
          }
          .muted { color: var(--muted); }
        </style>
      </head>
      <body>
        <section class="login-shell" data-testid="login-shell">
          <div class="hero">
            <div>
              <div class="eyebrow">Offline QA Workspace</div>
              <h1>Exercise a realistic chat UI without relying on external network stability.</h1>
              <p>The scenario includes login, channel switching, thread replies, unread counters, and composer actions so the API can validate a rich collaboration flow in an isolated environment.</p>
            </div>
            <div class="metric-grid">
              <div class="metric"><strong>Release room</strong><div>3 channels, 5 teammates, active support thread</div></div>
              <div class="metric"><strong>Artifacts ready</strong><div>Each successful run stores a screenshot and captured DOM.</div></div>
              <div class="metric"><strong>Offline friendly</strong><div>No third-party service is required after page load.</div></div>
            </div>
          </div>
          <form class="login-panel" id="login-form">
            <div class="eyebrow">Workspace Login</div>
            <h2>Enter the release command room</h2>
            <p>Any display name works. The test verifies state transfer into the workspace after login.</p>
            <label>
              Display name
              <input id="display-name" aria-label="Display name" placeholder="QA Engineer" />
            </label>
            <label>
              Team code
              <input id="team-code" aria-label="Team code" value="release-squad" />
            </label>
            <button class="primary" type="submit">Enter workspace</button>
          </form>
        </section>

        <section class="workspace" id="workspace" data-testid="chat-shell">
          <aside class="sidebar">
            <div class="brand">
              <div>
                <div class="brand-title">Release Room</div>
                <div class="brand-sub">QA automation workspace</div>
              </div>
              <div class="badge-box">RR</div>
            </div>
            <div class="status-pill">Live monitoring</div>
            <div>
              <div class="section-title">Channels</div>
              <div class="channels" id="channel-list"></div>
            </div>
            <div class="profile">
              <div class="avatar" id="profile-avatar">QA</div>
              <div>
                <div id="profile-name">Guest</div>
                <div class="muted">Automation operator</div>
              </div>
              <button class="ghost" type="button">Sync</button>
            </div>
          </aside>

          <main class="main">
            <header class="header">
              <div>
                <h3 id="channel-title">#general</h3>
                <div class="subhead" id="channel-subhead">Daily release coordination and smoke checks</div>
              </div>
              <div class="search-pill" role="searchbox" aria-label="workspace-search">Search releases, traces, and threads</div>
            </header>
            <section class="messages" id="message-feed"></section>
            <section class="composer">
              <label>
                Message draft
                <textarea id="message-input" aria-label="Message draft" placeholder="Post a status update to the channel"></textarea>
              </label>
              <div class="composer-row">
                <div class="typing" id="typing-state">No one is typing</div>
                <button class="primary" id="send-message" type="button">Send update</button>
              </div>
            </section>
          </main>

          <aside class="thread">
            <div class="thread-header">
              <h4 id="thread-title">Thread details</h4>
              <div class="muted" id="thread-subhead">Select a message to inspect replies.</div>
            </div>
            <section class="thread-feed" id="thread-feed"></section>
            <section class="thread-compose">
              <label>
                Thread reply
                <textarea id="thread-input" aria-label="Thread reply" placeholder="Add a threaded reply"></textarea>
              </label>
              <button class="primary" id="send-thread-reply" type="button">Reply in thread</button>
            </section>
          </aside>
        </section>

        <script>
          var channels = {
            general: {
              title: "#general",
              subhead: "Daily release coordination and smoke checks",
              unread: 2,
              messages: [
                {
                  id: "m1",
                  author: "Lina",
                  time: "09:10",
                  body: "Morning smoke run completed on chromium and webkit. Waiting on checkout mocks for firefox.",
                  chips: ["smoke", "checkout"],
                  thread: [
                    { author: "Mason", body: "Firefox worker is back up. I will rerun after the deploy window." },
                    { author: "Ari", body: "Please keep the trace bundle if checkout fails again." }
                  ]
                },
                {
                  id: "m2",
                  author: "Rina",
                  time: "09:18",
                  body: "Hotfix candidate looks good. We still need a full screenshot sweep across portal pages.",
                  chips: ["visual", "release"],
                  thread: [
                    { author: "Joon", body: "Naver and Daum are in progress. YES24 is queued next." }
                  ]
                }
              ]
            },
            support: {
              title: "#support",
              subhead: "Production support tickets and live operator handoff",
              unread: 5,
              messages: [
                {
                  id: "m3",
                  author: "Nora",
                  time: "09:26",
                  body: "Customer reports a delayed confirmation mail in staging. API latency is normal but queue depth is rising.",
                  chips: ["ticket", "mail"],
                  thread: [
                    { author: "Evan", body: "Observed the same trend in the replay job. Capturing additional logs now." }
                  ]
                },
                {
                  id: "m4",
                  author: "Theo",
                  time: "09:31",
                  body: "Support macro updated with the new outage banner and rollback note.",
                  chips: ["macro"],
                  thread: []
                }
              ]
            },
            ops: {
              title: "#ops",
              subhead: "Build, deployment, and infrastructure signals",
              unread: 1,
              messages: [
                {
                  id: "m5",
                  author: "Kira",
                  time: "09:42",
                  body: "Canary rollout is at 60 percent and error budget is flat. We can widen traffic after the next heartbeat.",
                  chips: ["canary", "infra"],
                  thread: [
                    { author: "Mika", body: "Heartbeat looks clean. Standing by for the final approval." }
                  ]
                }
              ]
            }
          };

          var currentChannel = "general";
          var selectedMessageId = "m1";
          var currentUser = "Guest";

          var loginShell = document.querySelector(".login-shell");
          var workspace = document.getElementById("workspace");
          var channelList = document.getElementById("channel-list");
          var channelTitle = document.getElementById("channel-title");
          var channelSubhead = document.getElementById("channel-subhead");
          var messageFeed = document.getElementById("message-feed");
          var threadFeed = document.getElementById("thread-feed");
          var threadTitle = document.getElementById("thread-title");
          var threadSubhead = document.getElementById("thread-subhead");
          var profileName = document.getElementById("profile-name");
          var profileAvatar = document.getElementById("profile-avatar");
          var messageInput = document.getElementById("message-input");
          var threadInput = document.getElementById("thread-input");
          var typingState = document.getElementById("typing-state");

          function getCurrentChannel() {
            return channels[currentChannel];
          }

          function getSelectedMessage() {
            var current = getCurrentChannel();
            for (var i = 0; i < current.messages.length; i += 1) {
              if (current.messages[i].id === selectedMessageId) {
                return current.messages[i];
              }
            }
            return current.messages[0] || null;
          }

          function createChipRow(chips) {
            var row = document.createElement("div");
            row.className = "chip-row";
            for (var i = 0; i < chips.length; i += 1) {
              var chip = document.createElement("span");
              chip.className = "chip";
              chip.textContent = chips[i];
              row.appendChild(chip);
            }
            return row;
          }

          function renderChannels() {
            channelList.innerHTML = "";
            var entries = Object.keys(channels);
            for (var i = 0; i < entries.length; i += 1) {
              var key = entries[i];
              var channel = channels[key];
              var button = document.createElement("button");
              button.type = "button";
              button.className = "channel-button" + (key === currentChannel ? " active" : "");
              button.dataset.channel = key;

              var hash = document.createElement("span");
              hash.textContent = "#";
              var name = document.createElement("span");
              name.textContent = channel.title.replace("#", "");
              var unread = document.createElement("span");
              unread.className = "count-pill";
              unread.textContent = String(channel.unread);

              button.appendChild(hash);
              button.appendChild(name);
              button.appendChild(unread);
              button.addEventListener("click", (function (channelKey) {
                return function () {
                  currentChannel = channelKey;
                  channels[channelKey].unread = 0;
                  selectedMessageId = channels[channelKey].messages[0] ? channels[channelKey].messages[0].id : null;
                  render();
                };
              })(key));

              channelList.appendChild(button);
            }
          }

          function renderMessages() {
            var channel = getCurrentChannel();
            channelTitle.textContent = channel.title;
            channelSubhead.textContent = channel.subhead;
            messageFeed.innerHTML = "";

            var stamp = document.createElement("div");
            stamp.className = "day-stamp";
            stamp.textContent = "Today";
            messageFeed.appendChild(stamp);

            for (var i = 0; i < channel.messages.length; i += 1) {
              var message = channel.messages[i];
              var article = document.createElement("article");
              article.className = "message-card" + (message.author === currentUser ? " self" : "");
              article.dataset.messageId = message.id;

              var avatar = document.createElement("div");
              avatar.className = "avatar";
              avatar.textContent = message.author.slice(0, 2).toUpperCase();

              var body = document.createElement("div");
              var meta = document.createElement("div");
              meta.className = "message-meta";
              var author = document.createElement("strong");
              author.textContent = message.author;
              var time = document.createElement("span");
              time.textContent = message.time;
              meta.appendChild(author);
              meta.appendChild(time);

              var text = document.createElement("div");
              text.className = "message-body";
              text.textContent = message.body;

              body.appendChild(meta);
              body.appendChild(text);
              body.appendChild(createChipRow(message.chips));

              article.appendChild(avatar);
              article.appendChild(body);
              article.addEventListener("click", (function (messageId) {
                return function () {
                  selectedMessageId = messageId;
                  renderThread();
                };
              })(message.id));

              messageFeed.appendChild(article);
            }
          }

          function renderThread() {
            var message = getSelectedMessage();
            threadFeed.innerHTML = "";
            if (!message) {
              threadTitle.textContent = "Thread details";
              threadSubhead.textContent = "Select a message to inspect replies.";
              return;
            }

            threadTitle.textContent = "Thread on " + message.author;
            threadSubhead.textContent = message.body;

            if (!message.thread.length) {
              var empty = document.createElement("div");
              empty.className = "thread-item muted";
              empty.textContent = "No replies yet. Add the first threaded note.";
              threadFeed.appendChild(empty);
              return;
            }

            for (var i = 0; i < message.thread.length; i += 1) {
              var reply = message.thread[i];
              var item = document.createElement("div");
              item.className = "thread-item";
              var replyAuthor = document.createElement("strong");
              replyAuthor.textContent = reply.author;
              var replyBody = document.createElement("div");
              replyBody.textContent = reply.body;
              item.appendChild(replyAuthor);
              item.appendChild(replyBody);
              threadFeed.appendChild(item);
            }
          }

          function render() {
            renderChannels();
            renderMessages();
            renderThread();
          }

          document.getElementById("login-form").addEventListener("submit", function (event) {
            event.preventDefault();
            currentUser = document.getElementById("display-name").value.trim() || "QA Engineer";
            profileName.textContent = currentUser;
            profileAvatar.textContent = currentUser.slice(0, 2).toUpperCase();
            loginShell.style.display = "none";
            workspace.style.display = "grid";
            render();
          });

          messageInput.addEventListener("input", function () {
            typingState.textContent = messageInput.value.trim() ? currentUser + " is drafting an update" : "No one is typing";
          });

          document.getElementById("send-message").addEventListener("click", function () {
            var value = messageInput.value.trim();
            if (!value) {
              return;
            }
            var current = getCurrentChannel();
            var newMessage = {
              id: "m" + Date.now(),
              author: currentUser,
              time: "09:55",
              body: value,
              chips: ["qa", "automation"],
              thread: []
            };
            current.messages.push(newMessage);
            selectedMessageId = newMessage.id;
            messageInput.value = "";
            typingState.textContent = "No one is typing";
            render();
          });

          document.getElementById("send-thread-reply").addEventListener("click", function () {
            var value = threadInput.value.trim();
            var message = getSelectedMessage();
            if (!value || !message) {
              return;
            }
            message.thread.push({ author: currentUser, body: value });
            threadInput.value = "";
            renderThread();
          });
        </script>
      </body>
    </html>
  `);

  await page.getByLabel("Display name").fill("Codex QA");
  await page.getByRole("button", { name: "Enter workspace" }).click();

  await expect(page.getByTestId("chat-shell")).toBeVisible();
  await page.locator("button[data-channel='support']").click();
  await expect(page.getByRole("heading", { name: "#support" })).toBeVisible();
  await expect(page.getByText("Production support tickets and live operator handoff")).toBeVisible();

  await page.locator("#message-feed article").filter({ hasText: "Customer reports a delayed confirmation mail in staging." }).first().click();
  await expect(page.getByText("Observed the same trend in the replay job. Capturing additional logs now.")).toBeVisible();

  await page.getByLabel("Thread reply").fill("Collected DOM, screenshot, and console logs for the staging alert.");
  await page.getByRole("button", { name: "Reply in thread" }).click();
  await expect(page.getByText("Collected DOM, screenshot, and console logs for the staging alert.")).toBeVisible();

  await page.getByLabel("Message draft").fill("Visual smoke checks are complete. Ready to publish the release report.");
  await expect(page.getByText("Codex QA is drafting an update")).toBeVisible();
  await page.getByRole("button", { name: "Send update" }).click();
  await expect(page.locator("#message-feed article").filter({ hasText: "Visual smoke checks are complete. Ready to publish the release report." }).first()).toBeVisible();

  await attachScreenshot(page, testInfo, "offline-chat-workspace");
  await attachHtml(page, testInfo, "offline-chat-workspace-dom");
});


