// Runs at document_start: flips the theme on before first paint and keeps
// the <html> flags in sync with settings so theme.css can key off them.

const MAS_DEFAULTS = {
  enabled: true,
  grain: true,   // stipple/film-grain overlay
  stars: true,   // starfield canvas
  dawn: true,    // horizon glow tied to daily progress
  hud: true,     // rotating hope-core microcopy
  motion: true,  // twinkle / beam animations (off = everything static)
};

function masApplyFlags(s) {
  const h = document.documentElement;
  h.classList.toggle('mas', s.enabled);
  h.toggleAttribute('data-mas-grain', s.enabled && s.grain);
  h.toggleAttribute('data-mas-motion', s.enabled && s.motion);
}

chrome.storage.sync.get(MAS_DEFAULTS, masApplyFlags);

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') chrome.storage.sync.get(MAS_DEFAULTS, masApplyFlags);
});
