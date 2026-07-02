const DEFAULTS = {
  enabled: true,
  grain: true,
  stars: true,
  dawn: true,
  hud: true,
  motion: true,
};

const boxes = [...document.querySelectorAll('input[type="checkbox"]')];

chrome.storage.sync.get(DEFAULTS, (s) => {
  for (const box of boxes) box.checked = s[box.id];
});

for (const box of boxes) {
  box.addEventListener('change', () => {
    chrome.storage.sync.set({ [box.id]: box.checked });
  });
}

// ---- sync config -------------------------------------------------------

const syncFields = ['syncUrl', 'syncToken'].map((id) => document.getElementById(id));
const status = document.getElementById('syncStatus');

chrome.storage.sync.get({ syncUrl: '', syncToken: '' }, (s) => {
  for (const field of syncFields) field.value = s[field.id];
  if (s.syncUrl && s.syncToken) status.textContent = 'sync configured';
});

for (const field of syncFields) {
  field.addEventListener('change', () => {
    chrome.storage.sync.set({ [field.id]: field.value.trim() }, () => {
      const configured = syncFields.every((f) => f.value.trim());
      status.textContent = configured ? 'saved — syncs on next dashboard load' : 'saved';
    });
  });
}
