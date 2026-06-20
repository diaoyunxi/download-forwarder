const toggleEl = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const serverInfoEl = document.getElementById('server-info');
const programGrid = document.getElementById('program-grid');
const argumentsEl = document.getElementById('arguments');

let enabled = false;
let selectedProgram = 'wget';

// Load saved settings
chrome.storage.local.get(['enabled', 'program', 'arguments', 'serverConnected', 'serverVersion'], (data) => {
  enabled = data.enabled || false;
  selectedProgram = data.program || 'wget';
  updateToggle();
  updateProgramUI();
  argumentsEl.value = data.arguments || '';
  updateServerStatus(data.serverConnected, data.serverVersion);
});

// Listen for real-time connection changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverConnected) {
    chrome.storage.local.get(['serverVersion'], (data) => {
      updateServerStatus(changes.serverConnected.newValue, data.serverVersion);
    });
  }
});

function updateToggle() {
  toggleEl.classList.toggle('active', enabled);
}

toggleEl.addEventListener('click', () => {
  enabled = !enabled;
  updateToggle();
  chrome.storage.local.set({ enabled });
});

function updateProgramUI() {
  document.querySelectorAll('.program-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.program === selectedProgram);
    btn.classList.toggle('disabled', !enabled);
  });
}

programGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.program-btn');
  if (!btn || !enabled) return;
  selectedProgram = btn.dataset.program;
  updateProgramUI();
  chrome.storage.local.set({ program: selectedProgram });
});

argumentsEl.addEventListener('input', () => {
  chrome.storage.local.set({ arguments: argumentsEl.value });
});

function updateServerStatus(connected, version) {
  statusEl.classList.toggle('connected', connected);
  statusEl.classList.toggle('disconnected', !connected);
  statusTextEl.textContent = connected ? '已连接' : '未连接';
  serverInfoEl.textContent = connected
    ? `本地服务器运行中 (v${version || '1.0.0'})`
    : '请先运行: python server/setup.py';
}