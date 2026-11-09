const STORAGE_KEY = "yaoyan-dashboard-ui-v14-1";

function readState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeState(next) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable in private browsing; the UI should still work.
  }
}

export function rememberedUiValue(key, fallback = "") {
  const value = readState()[key];
  return value === undefined || value === null ? fallback : value;
}

export function rememberUiValue(key, value) {
  writeState({ ...readState(), [key]: value });
}

export function forgetUiControls(ids = []) {
  const state = readState();
  ids.forEach(id => delete state[id]);
  writeState(state);
}

export function restoreUiControls(ids = []) {
  const state = readState();
  ids.forEach(id => {
    const control = document.getElementById(id);
    if (!control || state[id] === undefined) return;
    const value = String(state[id]);
    if (control.tagName === "SELECT" && !Array.from(control.options).some(option => option.value === value)) return;
    control.value = value;
  });
}

export function bindUiControlMemory(ids = []) {
  ids.forEach(id => {
    const control = document.getElementById(id);
    if (!control) return;
    const save = () => rememberUiValue(id, control.value);
    control.addEventListener("input", save);
    control.addEventListener("change", save);
  });
}

export function rememberedTab() {
  return rememberedUiValue("activeTab", "projects");
}

export function rememberTab(tab) {
  rememberUiValue("activeTab", tab);
}
