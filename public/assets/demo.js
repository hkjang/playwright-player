const COPY = window.__PW_PLAYER__.copy;
const statusText = document.getElementById('statusText');
const profileResult = document.getElementById('profileResult');
const counterValue = document.getElementById('counterValue');
const messageFeed = document.getElementById('messageFeed');
const chatSummary = document.getElementById('chatSummary');
const roleSelect = document.getElementById('roleSelect');

function appendMessage(text, className) {
  const item = document.createElement('li');
  if (className) {
    item.className = className;
  }
  item.textContent = text;
  messageFeed.append(item);
  item.scrollIntoView({ block: 'nearest' });
}

document.getElementById('primaryAction').addEventListener('click', () => {
  statusText.textContent = COPY.primaryClicked;
});
document.getElementById('secondaryAction').addEventListener('click', () => {
  statusText.textContent = COPY.secondaryClicked;
});
document.getElementById('saveProfile').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim() || 'anonymous';
  const role = roleSelect.options[roleSelect.selectedIndex]?.textContent || roleSelect.value;
  profileResult.textContent = COPY.savedProfileFor + ' ' + name + ' (' + role + ')';
  statusText.textContent = COPY.profileSaved;
});
document.getElementById('incrementCounter').addEventListener('click', () => {
  const next = Number(counterValue.textContent || '0') + 1;
  counterValue.textContent = String(next);
  statusText.textContent = COPY.counterUpdated;
});
document.getElementById('resetCounter').addEventListener('click', () => {
  counterValue.textContent = '0';
  statusText.textContent = COPY.counterReset;
});
document.getElementById('sendMessage').addEventListener('click', () => {
  const input = document.getElementById('messageInput');
  const value = input.value.trim();
  if (!value) {
    statusText.textContent = COPY.messageEmpty;
    return;
  }
  appendMessage(COPY.youPrefix + ': ' + value, '');
  appendMessage(COPY.botPrefix + ': ' + COPY.botEcho + ' -> ' + value, 'reply');
  chatSummary.textContent = COPY.lastMessage + ': ' + value;
  statusText.textContent = COPY.messageSent;
  input.value = '';
});
