import { EditorView, Decoration, WidgetType, ViewPlugin, keymap, drawSelection } from "https://esm.sh/@codemirror/view@6.43.12?deps=@codemirror/state@6.7.5";
import { history, historyKeymap, defaultKeymap, undo, redo } from "https://esm.sh/@codemirror/commands@6.11.1?deps=@codemirror/state@6.7.5,@codemirror/view@6.43.12";
import { markdown, markdownKeymap } from "https://esm.sh/@codemirror/lang-markdown@6.5.2?deps=@codemirror/state@6.7.5,@codemirror/view@6.43.12";
console.info("note v1.2 loaded");

const API = "https://api.github.com";
const state = {
  token: "",
  owner: "",
  repo: "",
  branch: "main",
  files: [],
  notes: [],
  current: null,
  currentSha: null,
  contents: new Map(),
  mode: "notes",
  wikiSuggestions: [],
  wikiSelected: 0,
  wikiRange: null,
  graph: { nodes: [], links: [], simulation: null, zoom: null, svg: null, ambientFrame: null, nodeSelection: null, linkSelection: null, positions: new Map() },
  editorMode: "live",
  editorView: null,
  syncingEditor: false,
  expandedFolders: new Set(),
  splitOrientation: "vertical",
  activePane: "primary",
  selectedFolder: "",
  secondary: { path: null, sha: null, mode: "live", editorView: null, syncing: false },
  tabs: [],
  activeTabId: null,
  nextTabId: 1,
  tabSeq: 0,
  imageTargetPane: "primary",
  imageInsertContext: null,
  mediaUrls: new Map(),
  highlightTargetPane: "primary",
  highlightInsertContext: null,
  dragTabId: null,
  dragImage: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  loginView: $("loginView"), appView: $("appView"),
  ownerInput: $("ownerInput"), repoInput: $("repoInput"), tokenInput: $("tokenInput"),
  connectBtn: $("connectBtn"), loginError: $("loginError"),
  fileList: $("fileList"), searchInput: $("searchInput"),
  emptyState: $("emptyState"), editorView: $("editorView"),
  pathInput: $("pathInput"), editorText: $("editorText"), liveEditorHost: $("liveEditorHost"),
  previewBtn: $("previewBtn"), editBtn: $("editBtn"), saveBtn: $("saveBtn"),
  newBtn: $("newBtn"), logoutBtn: $("logoutBtn"), vaultImport: $("vaultImport"),
  toast: $("toast"), backlinksList: $("backlinksList"), outgoingList: $("outgoingList"), vaultTitle: $("vaultTitle"),
  sidebar: $("sidebar"), menuBtn: $("menuBtn"), formatToolbar: $("formatToolbar"), wikiSuggest: $("wikiSuggest"),
  notesWorkspace: $("notesWorkspace"), graphWorkspace: $("graphWorkspace"), notesModeBtn: $("notesModeBtn"), graphModeBtn: $("graphModeBtn"),
  graphSvg: $("graphSvg"), graphLoading: $("graphLoading"), graphStats: $("graphStats"), graphRefreshBtn: $("graphRefreshBtn"), graphFitBtn: $("graphFitBtn"),
  graphSearch: $("graphSearch"), showMissingToggle: $("showMissingToggle"),
  tabStrip: $("tabStrip"), searchRibbonBtn: $("searchRibbonBtn"), rightPanelBtn: $("rightPanelBtn"),
  contextSidebar: $("contextSidebar"), branchStatus: $("branchStatus"), syncStatus: $("syncStatus"),
  statusWords: $("statusWords"), statusChars: $("statusChars"),
  paneHost: $("paneHost"), primaryPane: $("primaryPane"), secondaryPane: $("secondaryPane"), paneSplitter: $("paneSplitter"), splitBtn: $("splitBtn"),
  secondaryNoteTitle: $("secondaryNoteTitle"), secondaryPathInput: $("secondaryPathInput"), secondaryLiveEditorHost: $("secondaryLiveEditorHost"),
  secondaryEditorText: $("secondaryEditorText"), secondaryPreviewBtn: $("secondaryPreviewBtn"), secondaryEditBtn: $("secondaryEditBtn"),
  secondarySaveBtn: $("secondarySaveBtn"), secondaryCloseBtn: $("secondaryCloseBtn"), secondaryFormatToolbar: $("secondaryFormatToolbar"),
  newTabBtn: $("newTabBtn"), newNoteSidebarBtn: $("newNoteSidebarBtn"), newFolderBtn: $("newFolderBtn"),
  pathBreadcrumb: $("pathBreadcrumb"), editPathBtn: $("editPathBtn"), secondaryPathBreadcrumb: $("secondaryPathBreadcrumb"), secondaryEditPathBtn: $("secondaryEditPathBtn"),
  leftSidebarResizer: $("leftSidebarResizer"), rightSidebarResizer: $("rightSidebarResizer"),
  imageInput: $("imageInput"), highlightColorInput: $("highlightColorInput"), mediaPreview: $("mediaPreview"), secondaryMediaPreview: $("secondaryMediaPreview"),
};

try {
  const savedHighlight = localStorage.getItem("pv_highlight_color") || "#ffd84d";
  document.documentElement.style.setProperty("--note-highlight", savedHighlight);
  if (els.highlightColorInput) els.highlightColorInput.value = savedHighlight;
} catch {}

function headers(extra = {}) {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${state.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

async function gh(path, options = {}) {
  const res = await fetch(`${API}${path}`, { ...options, headers: headers(options.headers || {}) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToUtf8(base64) {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.add("hidden"), 2400);
}

function tabsStorageKey() {
  return `pv_tabs:${state.owner}/${state.repo}`;
}

function activeTab() {
  return state.tabs.find(t => t.id === state.activeTabId) || null;
}

function persistTabsWorkspace() {
  if (!state.owner || !state.repo) return;
  const paths = state.tabs.filter(t => !t.isNew && t.path).map(t => t.path);
  const active = activeTab();
  const payload = { paths: [...new Set(paths)], activePath: active && !active.isNew ? active.path : null };
  try { localStorage.setItem(tabsStorageKey(), JSON.stringify(payload)); } catch {}
}

function syncActiveTabText(text = null) {
  const tab = activeTab();
  if (!tab) return;
  const value = text == null ? getEditorMarkdown() : text;
  tab.text = value;
  tab.path = (els.pathInput?.value || tab.path || "").trim();
  tab.sha = state.currentSha;
  tab.dirty = tab.isNew || value !== (tab.savedText ?? value);
  const el = els.tabStrip?.querySelector(`[data-tab-id="${tab.id}"]`);
  el?.classList.toggle("dirty", !!tab.dirty);
  const dot = el?.querySelector(".tab-dirty");
  if (tab.dirty && !dot) { const d=document.createElement("span"); d.className="tab-dirty"; d.textContent="●"; el?.insertBefore(d, el.querySelector(".tab-close")); }
  if (!tab.dirty && dot) dot.remove();
  updateTabLabel(tab);
}

function captureActiveTab() {
  const tab = activeTab();
  if (!tab) return;
  try { syncActiveTabText(); } catch {}
}


function firstLineTitle(text = "") {
  const raw = String(text || "").split(/\r?\n/, 1)[0].trim();
  if (!raw) return "";
  return raw
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/==(?:\{#[0-9a-fA-F]{6}\})?(.+?)==/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/<u>(.*?)<\/u>/gi, "$1")
    .replace(/[`*_~]/g, "")
    .trim()
    .slice(0, 120);
}

function tabDisplayTitle(tab) {
  if (!tab) return "Новая заметка";
  const title = firstLineTitle(tab.text || "");
  if (title) return title;
  return tab.isNew ? "Новая заметка" : noteName(tab.path || "Новая заметка.md");
}

function updateTabLabel(tab) {
  if (!tab || !els.tabStrip) return;
  const el = els.tabStrip.querySelector(`[data-tab-id="${tab.id}"]`);
  const titleEl = el?.querySelector(".tab-title");
  if (titleEl) titleEl.textContent = tabDisplayTitle(tab);
  if (el) el.title = `${tabDisplayTitle(tab)}${tab.path ? `\n${tab.path}` : ""}`;
}

function reorderTabs(dragId, targetId, before = true) {
  if (!dragId || !targetId || dragId === targetId) return;
  const from = state.tabs.findIndex(t => t.id === dragId);
  let to = state.tabs.findIndex(t => t.id === targetId);
  if (from < 0 || to < 0) return;
  const [tab] = state.tabs.splice(from, 1);
  if (from < to) to -= 1;
  state.tabs.splice(before ? to : to + 1, 0, tab);
  renderTabs();
  persistTabsWorkspace();
}

async function closeOtherTabs(keepId) {
  const keep = state.tabs.find(t => t.id === keepId);
  if (!keep) return;
  const dirtyOthers = state.tabs.filter(t => t.id !== keepId && t.dirty);
  if (dirtyOthers.length && !confirm(`Закрыть ${dirtyOthers.length} несохранённых вкладок?`)) return;
  state.tabs = [keep];
  state.activeTabId = keep.id;
  await activateTab(keep.id);
}

function renameUnsavedTab(tab) {
  const raw = prompt("Имя файла", noteName(tab.path || "Новая заметка.md"));
  if (!raw) return;
  const clean = raw.trim().replace(/[\\/]/g, "-");
  const folder = folderOf(tab.path || "");
  tab.path = `${folder ? folder + "/" : ""}${clean}${clean.toLowerCase().endsWith(".md") ? "" : ".md"}`;
  if (tab.id === state.activeTabId) updatePrimaryPathUI(tab.path);
  renderTabs();
}

function moveUnsavedTab(tab) {
  const raw = prompt("Новый путь заметки", tab.path || "Новая заметка.md");
  if (!raw) return;
  let path = normalizeRepoPath(raw);
  if (!path.toLowerCase().endsWith(".md")) path += ".md";
  tab.path = path;
  if (tab.id === state.activeTabId) updatePrimaryPathUI(path);
  renderTabs();
}

function showTabContextMenu(tab, event) {
  event.preventDefault();
  event.stopPropagation();
  const saved = !tab.isNew && !!tab.path;
  showFloatingMenu([
    { label: "Редактировать", action: async () => { await activateTab(tab.id); state.editorView?.focus(); } },
    { label: "Переименовать файл", action: () => saved ? renameNoteFile(tab.path) : renameUnsavedTab(tab) },
    { label: "Переместить…", action: () => saved ? moveNoteFile(tab.path) : moveUnsavedTab(tab) },
    { label: "Создать копию", action: () => saved ? duplicateNoteFile(tab.path) : (() => { const copy = addNewTab(suggestedNewNotePath(), tab.text || ""); activateTab(copy.id); })() },
    { label: "Скопировать путь", action: () => copyRepoPath(tab.path || "") },
    { separator: true },
    { label: "Закрыть", action: () => closeTab(tab.id) },
    { label: "Закрыть остальные", action: () => closeOtherTabs(tab.id) },
  ], event.clientX, event.clientY);
}

function renderTabs() {
  if (!els.tabStrip) return;
  els.tabStrip.innerHTML = "";
  for (const tab of state.tabs) {
    const el = document.createElement("button");
    el.type = "button";
    el.draggable = true;
    el.dataset.tabId = tab.id;
    el.className = `note-tab ${tab.id === state.activeTabId ? "active" : ""} ${tab.dirty ? "dirty" : ""}`;
    el.title = `${tabDisplayTitle(tab)}${tab.path ? `\n${tab.path}` : ""}`;
    el.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4"/></svg><span class="tab-title">${escapeHtml(tabDisplayTitle(tab))}</span>${tab.dirty ? '<span class="tab-dirty">●</span>' : ''}<span class="tab-close" title="Закрыть">×</span>`;
    el.addEventListener("click", e => { if (!e.target.closest(".tab-close")) activateTab(tab.id); });
    el.addEventListener("contextmenu", e => showTabContextMenu(tab, e));
    el.querySelector(".tab-close")?.addEventListener("click", e => { e.stopPropagation(); closeTab(tab.id); });

    el.addEventListener("dragstart", e => {
      state.dragTabId = tab.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/private-vault-tab", tab.id);
      requestAnimationFrame(() => el.classList.add("dragging"));
    });
    el.addEventListener("dragend", () => { state.dragTabId = null; el.classList.remove("dragging"); });
    el.addEventListener("dragover", e => {
      if (!state.dragTabId || state.dragTabId === tab.id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      el.classList.toggle("drop-before", before);
      el.classList.toggle("drop-after", !before);
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
    el.addEventListener("drop", e => {
      if (!state.dragTabId || state.dragTabId === tab.id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      reorderTabs(state.dragTabId, tab.id, e.clientX < r.left + r.width / 2);
      state.dragTabId = null;
      el.classList.remove("drop-before", "drop-after");
    });
    els.tabStrip.appendChild(el);
  }
  requestAnimationFrame(() => els.tabStrip.querySelector(".note-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
}

async function hydrateTab(tab) {
  if (!tab || !tab.path || !tab.unloaded) return tab;
  const item = await getFile(tab.path);
  tab.text = item.text;
  tab.savedText = item.text;
  tab.sha = item.sha;
  tab.unloaded = false;
  tab.dirty = false;
  return tab;
}

async function activateTab(id) {
  const next = state.tabs.find(t => t.id === id);
  if (!next) return;
  captureActiveTab();
  try { await hydrateTab(next); } catch (e) { showToast(`Не удалось открыть вкладку: ${e.message}`); return; }
  state.activeTabId = next.id;
  state.current = next.isNew ? null : next.path;
  state.currentSha = next.sha || null;
  state.activePane = "primary";
  els.primaryPane.classList.add("pane-active");
  els.secondaryPane.classList.remove("pane-active");
  updatePrimaryPathUI(next.path || "");
  updateActiveNoteTitle(next.path || null);
  setEditorMarkdown(next.text || "");
  els.emptyState.classList.add("hidden");
  els.editorView.classList.remove("hidden");
  showPreview();
  renderTabs();
  renderFileList(els.searchInput.value);
  if (!next.isNew && next.path) await Promise.all([renderBacklinks(next.path), renderOutgoing(next.text || "")]);
  else { els.backlinksList.textContent = "—"; els.outgoingList.textContent = "—"; }
  persistTabsWorkspace();
}

function addSavedTab(path, item, makeActive = true) {
  let tab = state.tabs.find(t => !t.isNew && t.path === path);
  if (!tab) {
    tab = { id: `tab-${++state.tabSeq}`, path, sha: item?.sha || null, text: item?.text || "", savedText: item?.text || "", dirty: false, isNew: false, unloaded: !item };
    state.tabs.push(tab);
  } else if (item && !tab.dirty) {
    tab.sha = item.sha; tab.text = item.text; tab.savedText = item.text; tab.unloaded = false;
  }
  if (makeActive) state.activeTabId = tab.id;
  renderTabs(); persistTabsWorkspace();
  return tab;
}

function addNewTab(path, text = "") {
  const tab = { id: `tab-${++state.tabSeq}`, path, sha: null, text, savedText: "", dirty: true, isNew: true, unloaded: false };
  state.tabs.push(tab); state.activeTabId = tab.id; renderTabs();
  return tab;
}

async function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  if (tab.dirty && !confirm(`Закрыть «${noteName(tab.path || "Новая заметка.md")}» без сохранения?`)) return;
  const wasActive = id === state.activeTabId;
  state.tabs.splice(idx, 1);
  if (wasActive) {
    const fallback = state.tabs[Math.max(0, idx - 1)] || state.tabs[0] || null;
    if (fallback) await activateTab(fallback.id);
    else {
      state.activeTabId = null; state.current = null; state.currentSha = null;
      els.editorView.classList.add("hidden"); els.emptyState.classList.remove("hidden"); updateActiveNoteTitle(null); renderTabs();
    }
  } else renderTabs();
  persistTabsWorkspace();
}

async function restoreTabsWorkspace() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(tabsStorageKey()) || "null"); } catch {}
  if (!saved?.paths?.length) return;
  const valid = saved.paths.filter(path => state.notes.some(n => n.path === path));
  for (const path of valid) addSavedTab(path, null, false);
  const targetPath = valid.includes(saved.activePath) ? saved.activePath : valid[0];
  const target = state.tabs.find(t => t.path === targetPath);
  if (target) await activateTab(target.id);
}

let derivedUiTimer = 0;
function scheduleDerivedDocumentUI(text) {
  clearTimeout(derivedUiTimer);
  derivedUiTimer = setTimeout(() => {
    renderOutgoing(text);
    updateDocumentStatus(text);
  }, 140);
}

function updateDocumentStatus(text = "") {
  const plain = String(text).replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`~\[\]()!-]/g, " ");
  const words = (plain.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu) || []).length;
  els.statusWords.textContent = `Слов: ${words}`;
  els.statusChars.textContent = `Символов: ${String(text).length}`;
}

function updateActiveNoteTitle(path = null) {
  const tab = activeTab();
  if (tab && path) tab.path = path;
  renderTabs();
  persistTabsWorkspace();
}

function folderOf(path = "") {
  const clean = String(path || "").replace(/\\/g, "/");
  return clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
}


function renderBreadcrumb(target, path) {
  if (!target) return;
  target.innerHTML = "";
  const folder = folderOf(path || "");
  const parts = folder.split("/").filter(Boolean);
  if (!parts.length) {
    const root = document.createElement("span");
    root.className = "crumb current root-crumb";
    root.textContent = "Корень";
    target.appendChild(root);
    return;
  }
  let cumulative = "";
  parts.forEach((part, i) => {
    cumulative = cumulative ? `${cumulative}/${part}` : part;
    const seg = document.createElement("button");
    seg.className = `crumb ${i === parts.length - 1 ? "current" : ""}`;
    seg.type = "button";
    seg.textContent = part;
    const folderPath = cumulative;
    seg.title = `Папка ${folderPath}`;
    seg.onclick = () => {
      state.selectedFolder = folderPath;
      state.expandedFolders.add(folderPath);
      renderFileList(els.searchInput.value);
    };
    target.appendChild(seg);
    if (i < parts.length - 1) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "›";
      target.appendChild(sep);
    }
  });
}

function updatePrimaryPathUI(path) {
  els.pathInput.value = path || "";
  renderBreadcrumb(els.pathBreadcrumb, path || "");
  const f = folderOf(path);
  state.selectedFolder = f;
}

function updateSecondaryPathUI(path) {
  els.secondaryPathInput.value = path || "";
  renderBreadcrumb(els.secondaryPathBreadcrumb, path || "");
}

function togglePathEditor(which = "primary") {
  const input = which === "secondary" ? els.secondaryPathInput : els.pathInput;
  const breadcrumb = which === "secondary" ? els.secondaryPathBreadcrumb : els.pathBreadcrumb;
  input.classList.toggle("hidden");
  breadcrumb.classList.toggle("hidden", !input.classList.contains("hidden"));
  if (!input.classList.contains("hidden")) { input.focus(); input.select(); }
}

function closeFloatingMenu() {
  document.querySelectorAll(".floating-menu").forEach(el => el.remove());
}

function showFloatingMenu(items, x, y) {
  closeFloatingMenu();
  const menu = document.createElement("div");
  menu.className = "floating-menu";
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "menu-separator";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = item.danger ? "danger" : "";
    if (item.shortcut) btn.innerHTML = `<span>${escapeHtml(item.label)}</span><kbd>${escapeHtml(item.shortcut)}</kbd>`;
    else btn.textContent = item.label;
    btn.onclick = () => { closeFloatingMenu(); item.action(); };
    menu.appendChild(btn);
  }
  menu.addEventListener("pointerdown", e => e.stopPropagation());
  document.body.appendChild(menu);
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad))}px`;
  menu.style.top = `${Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad))}px`;
  setTimeout(() => document.addEventListener("pointerdown", closeFloatingMenu, { once: true }), 0);
}


function openNoteInActivePane(path) {
  if (els.paneHost.classList.contains("split-active") && state.activePane === "secondary") return openInSplit(path, state.splitOrientation, false);
  return openNote(path);
}

function attachFileOpenHandlers(button, path) {
  button.draggable = true;
  button.addEventListener("dragstart", e => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/private-vault-note", path);
    e.dataTransfer.setData("text/plain", path);
    button.classList.add("dragging-note");
  });
  button.addEventListener("dragend", () => button.classList.remove("dragging-note"));
  button.onclick = () => openNoteInActivePane(path);
  button.oncontextmenu = e => {
    e.preventDefault();
    e.stopPropagation();
    showFloatingMenu([
      { label: "Открыть", action: () => openNoteInActivePane(path) },
      { label: "Открыть справа", action: () => openInSplit(path, "vertical") },
      { label: "Открыть снизу", action: () => openInSplit(path, "horizontal") },
      { separator: true },
      { label: "Переименовать", action: () => renameNoteFile(path) },
      { label: "Переместить…", action: () => moveNoteFile(path) },
      { label: "Создать копию", action: () => duplicateNoteFile(path) },
      { label: "Скопировать путь", action: () => copyRepoPath(path) },
      { separator: true },
      { label: "Удалить", danger: true, action: () => deleteNoteFile(path) },
    ], e.clientX, e.clientY);
  };
}


function setSplitOrientation(orientation) {
  if (orientation === "vertical" && window.innerWidth < 720) orientation = "horizontal";
  state.splitOrientation = orientation;
  els.paneHost.classList.remove("split-vertical", "split-horizontal");
  els.paneHost.classList.add("split-active", orientation === "vertical" ? "split-vertical" : "split-horizontal");
  els.primaryPane.style.flexBasis = "50%";
  els.secondaryPane.style.flexBasis = "50%";
  els.secondaryPane.classList.remove("hidden");
  els.paneSplitter.classList.remove("hidden");
}

function closeSplit() {
  state.activePane = "primary";
  els.primaryPane.classList.add("pane-active");
  els.secondaryPane.classList.remove("pane-active");
  els.paneHost.classList.remove("split-active", "split-vertical", "split-horizontal");
  els.secondaryPane.classList.add("hidden");
  els.paneSplitter.classList.add("hidden");
  els.primaryPane.style.flexBasis = "";
  els.secondaryPane.style.flexBasis = "";
  state.secondary.path = null;
  state.secondary.sha = null;
}

function showSplitMenu(anchor = els.splitBtn) {
  if (!state.current) return showToast("Сначала открой заметку.");
  const rect = anchor.getBoundingClientRect();
  showFloatingMenu([
    { label: "Разделить справа", action: () => openInSplit(state.current, "vertical") },
    { label: "Разделить снизу", action: () => openInSplit(state.current, "horizontal") },
    ...(els.paneHost.classList.contains("split-active") ? [{ label: "Закрыть вторую область", action: closeSplit }] : []),
  ], rect.left, rect.bottom + 4);
}

function setSyncStatus(text) {
  els.syncStatus.textContent = text;
}

function toggleSidebar() {
  if (window.matchMedia("(max-width: 980px)").matches) {
    els.sidebar.classList.toggle("open");
  } else {
    els.appView.classList.toggle("sidebar-collapsed");
  }
}

function toggleContextSidebar() {
  if (window.matchMedia("(max-width: 980px)").matches) {
    els.contextSidebar.classList.toggle("open");
    els.rightPanelBtn.classList.toggle("active", els.contextSidebar.classList.contains("open"));
  } else {
    els.appView.classList.toggle("context-collapsed");
    els.rightPanelBtn.classList.toggle("active", !els.appView.classList.contains("context-collapsed"));
  }
}

async function connect() {
  els.loginError.textContent = "";
  state.owner = els.ownerInput.value.trim();
  state.repo = els.repoInput.value.trim();
  state.token = els.tokenInput.value.trim();

  if (!state.owner || !state.repo || !state.token) {
    els.loginError.textContent = "Заполни owner, repository и token.";
    return;
  }

  els.connectBtn.disabled = true;
  try {
    const repo = await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}`);
    state.branch = repo.default_branch || "main";

    sessionStorage.setItem("pv_owner", state.owner);
    sessionStorage.setItem("pv_repo", state.repo);
    sessionStorage.setItem("pv_token", state.token);

    els.vaultTitle.textContent = "note";
    els.branchStatus.textContent = state.branch;
    await loadTree();

    els.loginView.classList.add("hidden");
    els.appView.classList.remove("hidden");
    await restoreTabsWorkspace();
  } catch (e) {
    els.loginError.textContent = `Не удалось подключиться: ${e.message}`;
  } finally {
    els.connectBtn.disabled = false;
  }
}

async function loadTree() {
  const branch = await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/branches/${encodeURIComponent(state.branch)}`);
  const treeSha = branch.commit.commit.tree.sha;
  const tree = await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/git/trees/${treeSha}?recursive=1`);

  state.files = (tree.tree || []).filter(x => x.type === "blob");
  state.notes = state.files.filter(x => x.path.toLowerCase().endsWith(".md"));
  state.contents.clear();
  renderFileList();
}

function noteName(path) {
  return path.split("/").pop().replace(/\.md$/i, "");
}

function buildFileTree(notes) {
  const root = { folders: new Map(), files: [], path: "" };
  const ensureFolder = (folderPath) => {
    if (!folderPath) return root;
    let node = root;
    let currentPath = "";
    for (const part of folderPath.split("/").filter(Boolean)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [], path: currentPath });
      node = node.folders.get(part);
    }
    return node;
  };

  // Git does not store empty folders, so .gitkeep files are used as folder placeholders.
  for (const file of state.files) ensureFolder(folderOf(file.path));

  for (const note of notes.slice().sort((a, b) => a.path.localeCompare(b.path, "ru"))) {
    const parts = note.path.split("/");
    const filename = parts.pop();
    const node = ensureFolder(parts.join("/"));
    node.files.push({ ...note, filename });
  }
  return root;
}

function renderFileList(filter = "") {
  const q = filter.trim().toLowerCase();
  els.fileList.innerHTML = "";

  if (q) {
    const matches = state.notes
      .filter(n => n.path.toLowerCase().includes(q))
      .sort((a, b) => a.path.localeCompare(b.path, "ru"));
    if (!matches.length) {
      els.fileList.innerHTML = `<p class="muted small" style="padding:8px">Ничего не найдено.</p>`;
      return;
    }
    for (const note of matches) {
      const btn = document.createElement("button");
      btn.className = `file-item ${state.current === note.path ? "active" : ""}`;
      const folder = note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : "";
      btn.innerHTML = `<svg class="tree-icon file-icon-svg" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4"/></svg><span class="file-name">${escapeHtml(noteName(note.path))}</span>${folder ? `<span class="search-path">${escapeHtml(folder)}</span>` : ""}`;
      attachFileOpenHandlers(btn, note.path);
      els.fileList.appendChild(btn);
    }
    return;
  }

  if (!state.notes.length) {
    els.fileList.innerHTML = `<p class="muted small" style="padding:8px">Markdown-файлы не найдены.</p>`;
    return;
  }

  const tree = buildFileTree(state.notes);
  if (!state.expandedFolders.size) {
    for (const [name] of tree.folders) state.expandedFolders.add(name);
  }

  const renderNode = (node, container, level = 0) => {
    for (const [name, folder] of Array.from(node.folders.entries()).sort((a,b) => a[0].localeCompare(b[0], "ru"))) {
      const open = state.expandedFolders.has(folder.path);
      const row = document.createElement("button");
      row.className = `folder-row ${open ? "open" : ""} ${state.selectedFolder === folder.path ? "selected" : ""}`;
      row.style.paddingLeft = `${6 + level * 13}px`;
      row.innerHTML = `<span class="folder-chevron">›</span><svg class="tree-icon folder-icon" viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2H20.5v9.5H3.5z"/></svg><span class="folder-name">${escapeHtml(name)}</span>`;
      const children = document.createElement("div");
      children.className = `folder-children ${open ? "open" : ""}`;
      row.addEventListener("dragover", e => { if (Array.from(e.dataTransfer.types || []).includes("text/private-vault-note")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; row.classList.add("drop-target"); } });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", e => {
        e.preventDefault(); e.stopPropagation(); row.classList.remove("drop-target");
        const path = e.dataTransfer.getData("text/private-vault-note") || e.dataTransfer.getData("text/plain");
        if (path) moveNoteToFolder(path, folder.path);
      });
      row.onclick = () => {
        state.selectedFolder = folder.path;
        if (state.expandedFolders.has(folder.path)) state.expandedFolders.delete(folder.path);
        else state.expandedFolders.add(folder.path);
        renderFileList(els.searchInput.value);
      };
      row.oncontextmenu = e => {
        e.preventDefault();
        state.selectedFolder = folder.path;
        showFloatingMenu([
          { label: "Новая заметка", action: () => newNote(`${folder.path}/Новая заметка ${new Date().toISOString().slice(0,10)}.md`) },
          { label: "Новая вложенная папка", action: () => createFolder(folder.path) },
          { separator: true },
          { label: "Переименовать", action: () => renameFolder(folder.path) },
          { label: "Переместить…", action: () => moveFolderPrompt(folder.path) },
          { label: "Скопировать путь", action: () => copyRepoPath(folder.path) },
          { separator: true },
          { label: "Удалить папку", danger: true, action: () => deleteFolder(folder.path) },
        ], e.clientX, e.clientY);
      };
      container.appendChild(row);
      container.appendChild(children);
      renderNode(folder, children, level + 1);
    }

    for (const note of node.files.sort((a,b) => a.filename.localeCompare(b.filename, "ru"))) {
      const btn = document.createElement("button");
      btn.className = `file-item ${state.current === note.path ? "active" : ""}`;
      btn.style.paddingLeft = `${18 + level * 13}px`;
      btn.innerHTML = `<svg class="tree-icon file-icon-svg" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4"/></svg><span class="file-name">${escapeHtml(noteName(note.path))}</span>`;
      attachFileOpenHandlers(btn, note.path);
      container.appendChild(btn);
    }
  };
  renderNode(tree, els.fileList, 0);
}

async function getFile(path) {
  if (state.contents.has(path)) return state.contents.get(path);
  const data = await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(state.branch)}`);
  const text = base64ToUtf8(data.content || "");
  const item = { text, sha: data.sha };
  state.contents.set(path, item);
  return item;
}

async function openNote(path) {
  setMode("notes");
  try {
    captureActiveTab();
    let tab = state.tabs.find(t => !t.isNew && t.path === path);
    if (!tab) {
      const item = await getFile(path);
      tab = addSavedTab(path, item, false);
    } else if (tab.unloaded) {
      await hydrateTab(tab);
    }
    await activateTab(tab.id);
    els.sidebar.classList.remove("open");
    setSyncStatus("Готово");
  } catch (e) {
    showToast(`Ошибка: ${e.message}`);
  }
}

function normalizeWikiTarget(target) {
  return target.split("|")[0].split("#")[0].trim().replace(/\.md$/i, "");
}

function wikiTargetToPath(target) {
  const clean = normalizeWikiTarget(target);
  if (!clean) return null;
  const exact = state.notes.find(n => n.path.replace(/\.md$/i, "") === clean);
  if (exact) return exact.path;
  const lower = clean.toLowerCase();
  const byName = state.notes.find(n => noteName(n.path).toLowerCase() === lower);
  return byName ? byName.path : null;
}

function extractWikiLinks(text) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    const target = normalizeWikiTarget(raw);
    const alias = raw.includes("|") ? raw.split("|").slice(1).join("|").trim() : "";
    const heading = raw.split("|")[0].includes("#") ? raw.split("|")[0].split("#").slice(1).join("#").trim() : "";
    if (target) out.push({ raw, target, alias, heading, index: m.index });
  }
  return out;
}

class WikiLinkWidget extends WidgetType {
  constructor(raw, resolved) {
    super();
    this.raw = raw;
    this.resolved = resolved;
  }
  eq(other) { return other.raw === this.raw && other.resolved === this.resolved; }
  toDOM(view) {
    const span = document.createElement("span");
    const label = this.raw.includes("|") ? this.raw.split("|").slice(1).join("|") : this.raw.split("#")[0];
    span.className = `cm-wiki-chip ${this.resolved ? "" : "missing"}`;
    span.textContent = label || this.raw;
    span.title = this.resolved ? `Открыть [[${this.raw}]]` : `Создать [[${normalizeWikiTarget(this.raw)}]]`;
    span.addEventListener("mousedown", e => e.preventDefault());
    span.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (this.resolved) {
        const inSecondary = els.secondaryLiveEditorHost?.contains(view.dom);
        if (inSecondary && els.paneHost.classList.contains("split-active")) openInSplit(this.resolved, state.splitOrientation, false);
        else openNote(this.resolved);
      } else createFromMissingLink(this.raw);
    });
    return span;
  }
  ignoreEvent() { return true; }
}

function selectionTouches(view, from, to) {
  const sel = view.state.selection.main;
  if (sel.from === sel.to) return sel.from > from && sel.from < to;
  return sel.from < to && sel.to > from;
}

class TaskCheckboxWidget extends WidgetType {
  constructor(checked, checkPos) { super(); this.checked = checked; this.checkPos = checkPos; }
  eq(other) { return other.checked === this.checked && other.checkPos === this.checkPos; }
  toDOM(view) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "task-checkbox-widget";
    input.checked = this.checked;
    input.setAttribute("aria-label", this.checked ? "Выполнено" : "Не выполнено");
    input.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
    input.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      view.dispatch({ changes: { from: this.checkPos, to: this.checkPos + 1, insert: this.checked ? " " : "x" } });
      view.focus();
    });
    return input;
  }
  ignoreEvent() { return true; }
}

function imageMime(path) {
  const ext = String(path).split(".").pop().toLowerCase().split("?")[0];
  return ({ png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", gif:"image/gif", svg:"image/svg+xml", avif:"image/avif", bmp:"image/bmp" })[ext] || "application/octet-stream";
}

function base64ToBytes(base64) {
  const binary = atob(String(base64).replace(/\s/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function resolveImageRepoPath(target, notePath = "") {
  let clean = String(target || "").trim().replace(/^<|>$/g, "");
  try { clean = decodeURIComponent(clean); } catch {}
  if (/^(https?:|data:|blob:)/i.test(clean)) return { external: true, path: clean };
  clean = clean.replace(/^\.\//, "").replace(/\\/g, "/");

  const noteFolder = folderOf(notePath);
  if (noteFolder) {
    const rel = normalizeRepoPath(`${noteFolder}/${clean}`);
    const relative = state.files.find(f => f.path === rel);
    if (relative) return { external: false, path: relative.path };
  }

  const exact = state.files.find(f => f.path === clean);
  if (exact) return { external: false, path: exact.path };

  const name = clean.split("/").pop().toLowerCase();
  const byName = state.files.filter(f => f.path.split("/").pop().toLowerCase() === name);
  if (byName.length === 1) return { external: false, path: byName[0].path };
  return { external: false, path: noteFolder ? normalizeRepoPath(`${noteFolder}/${clean}`) : clean };
}

async function privateImageUrl(path) {
  if (state.mediaUrls.has(path)) return state.mediaUrls.get(path);
  const file = state.files.find(f => f.path === path);
  if (!file) throw new Error(`Изображение не найдено: ${path}`);

  let b64 = "";
  try {
    const content = await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(state.branch)}`);
    if (content?.encoding === "base64" && content?.content) b64 = String(content.content).replace(/\s/g, "");
  } catch {}
  if (!b64) b64 = await getBlobBase64(file.sha);

  const blob = new Blob([base64ToBytes(b64)], { type: imageMime(path) });
  const url = URL.createObjectURL(blob);
  state.mediaUrls.set(path, url);
  return url;
}


function updateImageWidthInView(view, from, to, width) {
  try {
    const raw = view.state.doc.sliceString(from, to);
    const w = Math.max(120, Math.min(1600, Math.round(width)));
    let next = raw;
    if (/^!\[\[[\s\S]+\]\]$/.test(raw)) {
      next = /\|\d+\]\]$/.test(raw) ? raw.replace(/\|\d+\]\]$/, `|${w}]]`) : raw.replace(/\]\]$/, `|${w}]]`);
    }
    if (next !== raw) view.dispatch({ changes: { from, to, insert: next } });
  } catch {}
}

class ImageInlineWidget extends WidgetType {
  constructor(target, alt, width, notePath, from, to) {
    super();
    this.target = target;
    this.alt = alt || "";
    this.width = width || 520;
    this.notePath = notePath || "";
    this.from = from;
    this.to = to;
  }
  eq(other) {
    return other.target === this.target && other.alt === this.alt && other.width === this.width &&
      other.notePath === this.notePath && other.from === this.from && other.to === this.to;
  }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.className = "cm-inline-image-widget";
    wrap.contentEditable = "false";
    wrap.draggable = true;
    wrap.dataset.imageTarget = this.target;
    const img = document.createElement("img");
    img.alt = this.alt || this.target.split("/").pop() || "image";
    img.style.width = `${Math.max(120, Math.min(1600, Number(this.width) || 520))}px`;
    img.style.maxWidth = "100%";
    const loading = document.createElement("span");
    loading.className = "cm-image-loading";
    loading.textContent = "Загрузка…";
    const handle = document.createElement("span");
    handle.className = "cm-image-resize-handle";
    handle.title = "Потяни, чтобы изменить размер";
    wrap.append(img, loading, handle);

    const resolved = resolveImageRepoPath(this.target, this.notePath);
    const show = url => {
      img.src = url;
      img.addEventListener("load", () => loading.remove(), { once: true });
      img.addEventListener("error", () => {
        loading.textContent = `Не удалось открыть ${this.target}`;
        loading.classList.add("error");
      }, { once: true });
    };
    if (resolved.external) show(resolved.path);
    else privateImageUrl(resolved.path).then(show).catch(err => {
      loading.textContent = err?.message || `Не удалось открыть ${this.target}`;
      loading.classList.add("error");
    });

    wrap.addEventListener("dragstart", e => {
      const markdown = view.state.doc.sliceString(this.from, this.to);
      state.dragImage = { view, from: this.from, to: this.to, markdown };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/private-vault-image", markdown);
      e.stopPropagation();
    });
    wrap.addEventListener("dragend", () => { setTimeout(() => { state.dragImage = null; }, 0); });

    handle.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = img.getBoundingClientRect().width || Number(this.width) || 520;
      handle.setPointerCapture?.(e.pointerId);
      const move = ev => {
        const next = Math.max(120, Math.min(1600, startWidth + ev.clientX - startX));
        img.style.width = `${next}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const finalWidth = img.getBoundingClientRect().width || startWidth;
        updateImageWidthInView(view, this.from, this.to, finalWidth);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    });
    return wrap;
  }
  ignoreEvent(event) { return !!event?.target?.closest?.(".cm-inline-image-widget"); }
}

class TaskInlineWidget extends WidgetType {
  constructor(checked, checkPos) { super(); this.checked = checked; this.checkPos = checkPos; }
  eq(other) { return other.checked === this.checked && other.checkPos === this.checkPos; }
  toDOM(view) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "task-inline-widget";
    input.checked = this.checked;
    input.tabIndex = -1;
    input.setAttribute("aria-label", this.checked ? "Выполнено" : "Не выполнено");
    input.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); });
    input.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      const current = view.state.doc.sliceString(this.checkPos, this.checkPos + 1);
      view.dispatch({ changes: { from: this.checkPos, to: this.checkPos + 1, insert: /[xX]/.test(current) ? " " : "x" } });
    });
    return input;
  }
  ignoreEvent() { return true; }
}

class BulletInlineWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "bullet-inline-widget";
    span.textContent = "•";
    return span;
  }
  ignoreEvent() { return true; }
}

class ExternalLinkWidget extends WidgetType {
  constructor(label, href) { super(); this.label = label; this.href = href; }
  eq(other) { return other.label === this.label && other.href === this.href; }
  toDOM() {
    const a = document.createElement("a");
    a.className = "cm-live-link-chip";
    a.href = this.href;
    a.textContent = this.label;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.addEventListener("mousedown", e => e.preventDefault());
    a.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); window.open(this.href, "_blank", "noopener,noreferrer"); });
    return a;
  }
  ignoreEvent() { return true; }
}

function buildLiveDecorations(view) {
  const ranges = [];
  const seenLines = new Set();
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const activeLines = new Set([doc.lineAt(sel.from).number, doc.lineAt(sel.to).number]);
  const viewPath = els.secondaryLiveEditorHost?.contains(view.dom) ? state.secondary.path : (els.pathInput?.value || state.current || "");

  const hide = (from, to, active) => {
    if (to <= from || active) return;
    ranges.push(Decoration.replace({}).range(from, to));
  };

  for (const vr of view.visibleRanges) {
    let pos = vr.from;
    while (pos <= vr.to && pos <= doc.length) {
      const line = doc.lineAt(pos);
      if (!seenLines.has(line.number)) {
        seenLines.add(line.number);
        const text = line.text;
        const base = line.from;
        const active = activeLines.has(line.number);

        if (line.number === 1 && text.trim() && !/^#{1,6}\s+/.test(text)) {
          ranges.push(Decoration.line({ class: "cm-note-title-line" }).range(base));
          ranges.push(Decoration.mark({ class: "cm-note-title-text" }).range(base, line.to));
        }

        const imageSpans = [];
        const obsImageRe = /!\[\[([^\]|]+?\.(?:png|jpe?g|gif|webp|svg|avif|bmp))(?:\|(\d+))?\]\]/ig;
        let imgm;
        while ((imgm = obsImageRe.exec(text)) !== null) {
          const from = base + imgm.index, to = from + imgm[0].length;
          imageSpans.push([from, to]);
          ranges.push(Decoration.replace({
            widget: new ImageInlineWidget(imgm[1], "", imgm[2] || 520, viewPath, from, to)
          }).range(from, to));
        }
        const mdImageRe = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g;
        while ((imgm = mdImageRe.exec(text)) !== null) {
          const from = base + imgm.index, to = from + imgm[0].length;
          imageSpans.push([from, to]);
          ranges.push(Decoration.replace({
            widget: new ImageInlineWidget(imgm[2], imgm[1], 520, viewPath, from, to)
          }).range(from, to));
        }
        const overlapsImage = (from, to) => imageSpans.some(([a,b]) => from < b && to > a);

        const wikiSpans = [];
        const wikiRe = /(?<!!)\[\[([^\]]+)\]\]/g;
        let wm;
        while ((wm = wikiRe.exec(text)) !== null) {
          const from = base + wm.index, to = from + wm[0].length;
          if (overlapsImage(from, to)) continue;
          wikiSpans.push([from, to]);
          const rawWiki = wm[1];
          const resolved = wikiTargetToPath(rawWiki);
          if (!active) ranges.push(Decoration.replace({ widget: new WikiLinkWidget(rawWiki, resolved) }).range(from, to));
          else ranges.push(Decoration.mark({ class: `cm-live-wiki-target ${resolved ? "" : "missing"}`, attributes: { "data-wiki": rawWiki } }).range(from + 2, to - 2));
        }
        const overlapsWiki = (from, to) => wikiSpans.some(([a,b]) => from < b && to > a);

        const linkRe = /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g;
        let lm;
        while ((lm = linkRe.exec(text)) !== null) {
          const from = base + lm.index, to = from + lm[0].length;
          if (overlapsWiki(from, to) || overlapsImage(from, to)) continue;
          if (!active) ranges.push(Decoration.replace({ widget: new ExternalLinkWidget(lm[1], lm[2]) }).range(from, to));
          else {
            const labelFrom = from + 1, labelTo = labelFrom + lm[1].length;
            ranges.push(Decoration.mark({ class: "cm-live-link", attributes: { "data-href": lm[2] } }).range(labelFrom, labelTo));
          }
        }

        const hm = text.match(/^(#{1,6})\s+/);
        if (hm) {
          const markerTo = base + hm[0].length, level = hm[1].length;
          ranges.push(Decoration.line({ class: `cm-live-heading-line cm-live-heading-${level}` }).range(base));
          hide(base, markerTo, active);
          if (markerTo < line.to) ranges.push(Decoration.mark({ class: `cm-live-heading-text cm-live-h${level}` }).range(markerTo, line.to));
        }
        if (/^\s*>\s?/.test(text)) ranges.push(Decoration.line({ class: "cm-live-blockquote" }).range(base));

        const boldRe = /\*\*([^\n]+?)\*\*/g; let bm;
        while ((bm = boldRe.exec(text)) !== null) {
          const from = base + bm.index, to = from + bm[0].length;
          if (!overlapsWiki(from, to) && !overlapsImage(from, to)) {
            hide(from, from + 2, active); hide(to - 2, to, active);
            ranges.push(Decoration.mark({ class: "cm-live-bold" }).range(from + 2, to - 2));
          }
        }
        const italicRe = /(?<!\*)\*([^*\n]+?)\*(?!\*)/g; let im;
        while ((im = italicRe.exec(text)) !== null) {
          const from = base + im.index, to = from + im[0].length;
          if (!overlapsWiki(from, to) && !overlapsImage(from, to)) {
            hide(from, from + 1, active); hide(to - 1, to, active);
            ranges.push(Decoration.mark({ class: "cm-live-italic" }).range(from + 1, to - 1));
          }
        }
        const strikeRe = /~~([^\n]+?)~~/g; let sm;
        while ((sm = strikeRe.exec(text)) !== null) {
          const from = base + sm.index, to = from + sm[0].length;
          if (!overlapsWiki(from, to) && !overlapsImage(from, to)) {
            hide(from, from + 2, active); hide(to - 2, to, active);
            ranges.push(Decoration.mark({ class: "cm-live-strike" }).range(from + 2, to - 2));
          }
        }
        const highlightRe = /==(?:\{(#[0-9a-fA-F]{6})\})?([^\n]+?)==/g; let hlm;
        while ((hlm = highlightRe.exec(text)) !== null) {
          const from = base + hlm.index, to = from + hlm[0].length;
          if (!overlapsWiki(from, to) && !overlapsImage(from, to)) {
            const prefixLen = hlm[1] ? 11 : 2; // =={#RRGGBB}
            hide(from, from + prefixLen, active); hide(to - 2, to, active);
            const attrs = hlm[1] ? { style: `background-color:${hlm[1]}` } : {};
            ranges.push(Decoration.mark({ class: "cm-live-highlight", attributes: attrs }).range(from + prefixLen, to - 2));
          }
        }
        const underlineRe = /<u>([^\n]+?)<\/u>/gi; let ulm;
        while ((ulm = underlineRe.exec(text)) !== null) {
          const from = base + ulm.index, to = from + ulm[0].length;
          hide(from, from + 3, active); hide(to - 4, to, active);
          ranges.push(Decoration.mark({ class: "cm-live-underline" }).range(from + 3, to - 4));
        }

        const taskMatch = text.match(/^(\s*)([-*+])\s+\[([ xX])\](\s+)/);
        if (taskMatch) {
          ranges.push(Decoration.line({ class: "cm-live-task-line" }).range(base));
          if (!active) {
            const markerFrom = base + taskMatch[1].length;
            const markerTo = base + taskMatch[0].length;
            const checkPos = base + taskMatch[0].indexOf("[") + 1;
            ranges.push(Decoration.replace({ widget: new TaskInlineWidget(/[xX]/.test(taskMatch[3]), checkPos) }).range(markerFrom, markerTo));
          }
        } else {
          const bulletMatch = text.match(/^(\s*)([-*+])(\s+)/);
          if (bulletMatch) {
            ranges.push(Decoration.line({ class: "cm-live-list-line" }).range(base));
            if (!active) {
              const markerFrom = base + bulletMatch[1].length;
              const markerTo = base + bulletMatch[0].length;
              ranges.push(Decoration.replace({ widget: new BulletInlineWidget() }).range(markerFrom, markerTo));
            }
          } else if (/^\s*\d+[.)]\s+/.test(text)) {
            ranges.push(Decoration.line({ class: "cm-live-list-line" }).range(base));
          }
        }
      }
      if (line.to >= doc.length || line.to >= vr.to) break;
      pos = line.to + 1;
    }
  }
  ranges.sort((a,b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
}

const livePreviewDecorations = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildLiveDecorations(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet) this.decorations = buildLiveDecorations(update.view);
  }
}, { decorations: v => v.decorations });

function handleLiveEditorPointer(event, view, pane = "primary") {
  const external = event.target?.closest?.(".cm-live-link[data-href]");
  if (external) {
    event.preventDefault();
    event.stopPropagation();
    const href = external.dataset.href;
    if (href) window.open(href, "_blank", "noopener,noreferrer");
    return true;
  }

  const wiki = event.target?.closest?.(".cm-live-wiki-target[data-wiki]");
  if (wiki) {
    event.preventDefault();
    event.stopPropagation();
    const raw = wiki.dataset.wiki || "";
    const resolved = wikiTargetToPath(raw);
    if (resolved) {
      if (pane === "secondary" && els.paneHost.classList.contains("split-active")) openInSplit(resolved, state.splitOrientation, false);
      else openNote(resolved);
    } else createFromMissingLink(raw);
    return true;
  }
  return false;
}

function imageFileFromTransfer(dataTransfer) {
  if (!dataTransfer) return null;
  const files = Array.from(dataTransfer.files || []);
  return files.find(file => /^image\//i.test(file.type || "") || /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(file.name || "")) || null;
}

function initLiveEditor(initialDoc = "") {
  if (state.editorView) return state.editorView;
  state.editorView = new EditorView({
    doc: initialDoc,
    parent: els.liveEditorHost,
    extensions: [
      history(),
      drawSelection(),
      markdown(),
      EditorView.lineWrapping,
      livePreviewDecorations,
      keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => {
        if (state.syncingEditor) return;
        if (update.docChanged) {
          const value = update.state.doc.toString();
          els.editorText.value = value;
          syncActiveTabText(value);
          scheduleDerivedDocumentUI(value);
        }
        if (update.docChanged || update.selectionSet || update.viewportChanged) scheduleWikiSuggestions();
      }),
      EditorView.domEventHandlers({
        keydown(event) { return handleEditorKeydown(event); },
        mousedown(event, view) { return handleLiveEditorPointer(event, view, "primary"); },
        paste(event) {
          const file = imageFileFromTransfer(event.clipboardData);
          if (!file) return false;
          event.preventDefault();
          const sel = state.editorView.state.selection.main;
          state.imageTargetPane = "primary";
          state.imageInsertContext = { pane: "primary", start: sel.from, end: sel.to, notePath: els.pathInput.value.trim() || state.current || "" };
          uploadImageForPane(file, "primary");
          return true;
        },
        drop(event, view) {
          const file = imageFileFromTransfer(event.dataTransfer);
          if (file) {
            event.preventDefault();
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
            state.imageTargetPane = "primary";
            state.imageInsertContext = { pane: "primary", start: pos, end: pos, notePath: els.pathInput.value.trim() || state.current || "" };
            uploadImageForPane(file, "primary");
            return true;
          }
          if (state.dragImage?.view === view) {
            event.preventDefault();
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
            const { from, to, markdown } = state.dragImage;
            if (pos >= from && pos <= to) return true;
            const changes = pos < from
              ? [{ from: pos, to: pos, insert: markdown }, { from, to, insert: "" }]
              : [{ from, to, insert: "" }, { from: pos, to: pos, insert: markdown }];
            view.dispatch({ changes });
            state.dragImage = null;
            return true;
          }
          return false;
        },
        blur() { setTimeout(() => hideWikiSuggestions(), 150); return false; },
      }),
    ],
  });
  return state.editorView;
}

function getEditorMarkdown() {
  if (state.editorMode === "raw" || !state.editorView) return els.editorText.value;
  return state.editorView.state.doc.toString();
}

function initSecondaryLiveEditor() {
  if (state.secondary.editorView) return state.secondary.editorView;
  state.secondary.editorView = new EditorView({
    doc: "",
    parent: els.secondaryLiveEditorHost,
    extensions: [
      history(), drawSelection(), markdown(), EditorView.lineWrapping,
      livePreviewDecorations,
      keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => {
        if (state.secondary.syncing) return;
        if (update.docChanged) {
          const value = update.state.doc.toString();
          els.secondaryEditorText.value = value;
        }
      }),
      EditorView.domEventHandlers({
        keydown(event) { return handleSecondaryKeydown(event); },
        mousedown(event, view) { return handleLiveEditorPointer(event, view, "secondary"); },
        paste(event) {
          const file = imageFileFromTransfer(event.clipboardData);
          if (!file) return false;
          event.preventDefault();
          const sel = state.secondary.editorView.state.selection.main;
          state.imageTargetPane = "secondary";
          state.imageInsertContext = { pane: "secondary", start: sel.from, end: sel.to, notePath: els.secondaryPathInput.value.trim() || state.secondary.path || "" };
          uploadImageForPane(file, "secondary");
          return true;
        },
        drop(event, view) {
          const file = imageFileFromTransfer(event.dataTransfer);
          if (file) {
            event.preventDefault();
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
            state.imageTargetPane = "secondary";
            state.imageInsertContext = { pane: "secondary", start: pos, end: pos, notePath: els.secondaryPathInput.value.trim() || state.secondary.path || "" };
            uploadImageForPane(file, "secondary");
            return true;
          }
          if (state.dragImage?.view === view) {
            event.preventDefault();
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
            const { from, to, markdown } = state.dragImage;
            if (pos >= from && pos <= to) return true;
            const changes = pos < from
              ? [{ from: pos, to: pos, insert: markdown }, { from, to, insert: "" }]
              : [{ from, to, insert: "" }, { from: pos, to: pos, insert: markdown }];
            view.dispatch({ changes });
            state.dragImage = null;
            return true;
          }
          return false;
        },
      }),
    ],
  });
  return state.secondary.editorView;
}

function setSecondaryLiveDoc(text, cursor = 0) {
  const view = initSecondaryLiveEditor();
  state.secondary.syncing = true;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: Math.max(0, Math.min(cursor, text.length)) },
  });
  state.secondary.syncing = false;
}

function setSecondaryMarkdown(text) {
  els.secondaryEditorText.value = text;
  setSecondaryLiveDoc(text, 0);
}

function getSecondaryMarkdown() {
  if (state.secondary.mode === "raw" || !state.secondary.editorView) return els.secondaryEditorText.value;
  return state.secondary.editorView.state.doc.toString();
}

function showSecondaryPreview() {
  if (state.secondary.mode === "raw") setSecondaryLiveDoc(els.secondaryEditorText.value, els.secondaryEditorText.selectionStart || 0);
  state.secondary.mode = "live";
  els.secondaryLiveEditorHost.classList.remove("hidden");
  els.secondaryEditorText.classList.add("hidden");
  els.secondaryPreviewBtn.classList.add("active");
  els.secondaryEditBtn.classList.remove("active");
  initSecondaryLiveEditor();
}

function showSecondaryEditor() {
  els.secondaryEditorText.value = state.secondary.editorView ? state.secondary.editorView.state.doc.toString() : els.secondaryEditorText.value;
  state.secondary.mode = "raw";
  els.secondaryLiveEditorHost.classList.add("hidden");
  els.secondaryEditorText.classList.remove("hidden");
  els.secondaryEditBtn.classList.add("active");
  els.secondaryPreviewBtn.classList.remove("active");
}

async function openInSplit(path, orientation = "vertical", resetOrientation = true) {
  setMode("notes");
  try {
    const item = await getFile(path);
    state.secondary.path = path;
    state.secondary.sha = item.sha;
    state.activePane = "secondary";
    els.primaryPane.classList.remove("pane-active");
    els.secondaryPane.classList.add("pane-active");
    updateSecondaryPathUI(path);
    els.secondaryNoteTitle.textContent = noteName(path);
    setSecondaryMarkdown(item.text);
    if (resetOrientation || !els.paneHost.classList.contains("split-active")) setSplitOrientation(orientation);
    showSecondaryPreview();
    els.sidebar.classList.remove("open");
    setTimeout(() => state.secondary.editorView?.focus(), 0);
  } catch (e) {
    showToast(`Не удалось открыть вторую область: ${e.message}`);
  }
}

function secondarySelection() {
  if (state.secondary.mode === "live" && state.secondary.editorView) {
    const sel = state.secondary.editorView.state.selection.main;
    return { text: state.secondary.editorView.state.doc.toString(), start: sel.from, end: sel.to, cursor: sel.head };
  }
  return { text: els.secondaryEditorText.value, start: els.secondaryEditorText.selectionStart, end: els.secondaryEditorText.selectionEnd, cursor: els.secondaryEditorText.selectionStart };
}

function replaceSecondaryRange(from, to, insert, cursor = from + insert.length, selectFrom = null, selectTo = null) {
  if (state.secondary.mode === "live" && state.secondary.editorView) {
    const selection = selectFrom == null ? { anchor: cursor } : { anchor: selectFrom, head: selectTo };
    state.secondary.editorView.dispatch({ changes: { from, to, insert }, selection, scrollIntoView: true });
    state.secondary.editorView.focus();
  } else {
    els.secondaryEditorText.setRangeText(insert, from, to, "start");
    if (selectFrom == null) els.secondaryEditorText.setSelectionRange(cursor, cursor);
    else els.secondaryEditorText.setSelectionRange(selectFrom, selectTo);
    els.secondaryEditorText.focus();
  }
}

function secondaryReplaceSelection(before, after = before, placeholder = "текст") {
  const sel = secondarySelection();
  const selected = sel.text.slice(sel.start, sel.end) || placeholder;
  const insert = `${before}${selected}${after}`;
  const selectedFrom = sel.start + before.length;
  const selectedTo = selectedFrom + selected.length;
  replaceSecondaryRange(sel.start, sel.end, insert, selectedTo, selectedFrom, selectedTo);
}

function secondaryPrefixLines(prefixer, selectResult = true) {
  const sel = secondarySelection();
  const text = sel.text;
  const lineStart = text.lastIndexOf("\n", Math.max(0, sel.start - 1)) + 1;
  let lineEnd = text.indexOf("\n", sel.end);
  if (lineEnd === -1) lineEnd = text.length;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n").map((line, i) => `${prefixer(i)}${line}`).join("\n");
  if (selectResult) replaceSecondaryRange(lineStart, lineEnd, lines, lineStart + lines.length, lineStart, lineStart + lines.length);
  else replaceSecondaryRange(lineStart, lineEnd, lines, lineStart + lines.length);
}

function secondaryToolbarAction(action) {
  if (action === "undo") { if (state.secondary.mode === "live" && state.secondary.editorView) return undo(state.secondary.editorView); document.execCommand("undo"); return; }
  if (action === "redo") { if (state.secondary.mode === "live" && state.secondary.editorView) return redo(state.secondary.editorView); document.execCommand("redo"); return; }
  if (action === "bold") return secondaryReplaceSelection("**", "**", "жирный текст");
  if (action === "italic") return secondaryReplaceSelection("*", "*", "курсив");
  if (action === "strike") return secondaryReplaceSelection("~~", "~~", "зачёркнутый текст");
  if (action === "underline") return secondaryReplaceSelection("<u>", "</u>", "подчёркнутый текст");
  if (action === "highlight") return requestHighlightColor("secondary");
  if (action === "link") return insertExternalLink("secondary");
  if (action === "image") return requestImageInsert("secondary");
  if (action === "hr") { const sel = secondarySelection(); replaceSecondaryRange(sel.start, sel.end, "\n---\n"); return; }
  if (action === "fullscreen") { document.body.classList.toggle("focus-mode"); return; }
  if (action === "quote") return secondaryPrefixLines(() => "> ");
  if (action === "wiki") {
    const sel = secondarySelection();
    const selected = sel.text.slice(sel.start, sel.end).trim();
    const target = selected || prompt("Название заметки", "");
    if (!target) return;
    const insert = `[[${target}]]`;
    replaceSecondaryRange(sel.start, sel.end, insert, sel.start + insert.length);
    return;
  }
  if (action === "h1") return secondaryPrefixLines(() => "# ");
  if (action === "h2") return secondaryPrefixLines(() => "## ");
  if (action === "h3") return secondaryPrefixLines(() => "### ");
  if (action === "bullet") return secondaryPrefixLines(() => "- ");
  if (action === "numbered") return secondaryPrefixLines(i => `${i + 1}. `);
  if (action === "todo") return secondaryPrefixLines(() => "- [ ] ", false);
}

function handleSecondaryKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveSecondary(); return true; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") { e.preventDefault(); secondaryToolbarAction("bold"); return true; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") { e.preventDefault(); secondaryToolbarAction("italic"); return true; }
  return false;
}

function setLiveEditorDoc(text, cursor = null) {
  const view = initLiveEditor();
  state.syncingEditor = true;
  const anchor = cursor == null ? Math.min(view.state.selection.main.head, text.length) : Math.max(0, Math.min(cursor, text.length));
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor },
  });
  state.syncingEditor = false;
}

function setEditorMarkdown(text) {
  if (state.editorView) {
    try { state.editorView.destroy(); } catch {}
    state.editorView = null;
    els.liveEditorHost.innerHTML = "";
  }
  els.editorText.value = text;
  state.syncingEditor = true;
  state.editorView = initLiveEditor(text);
  state.syncingEditor = false;
  updateDocumentStatus(text);
}

function showPreview() {
  // Live Preview mode.
  if (state.editorMode === "raw") setLiveEditorDoc(els.editorText.value, els.editorText.selectionStart || 0);
  state.editorMode = "live";
  els.liveEditorHost.classList.remove("hidden");
  els.editorText.classList.add("hidden");
  els.previewBtn.classList.add("active");
  els.editBtn.classList.remove("active");
  initLiveEditor();
}

function showEditor() {
  // Raw Markdown mode.
  const markdownText = state.editorView ? state.editorView.state.doc.toString() : els.editorText.value;
  els.editorText.value = markdownText;
  state.editorMode = "raw";
  els.liveEditorHost.classList.add("hidden");
  els.editorText.classList.remove("hidden");
  els.editBtn.classList.add("active");
  els.previewBtn.classList.remove("active");
}

async function persistMarkdownFile({ path, oldPath, currentSha, markdownText }) {
  if (!path) throw new Error("Укажи путь файла.");
  if (!path.toLowerCase().endsWith(".md")) path += ".md";

  let targetSha = (currentSha && path === oldPath) ? currentSha : null;
  if (!targetSha) {
    try {
      const existing = await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(state.branch)}`);
      if (existing && existing.type === "file" && existing.sha) {
        if (oldPath !== path) {
          const overwrite = confirm(`Файл ${path} уже существует в vault. Заменить его текущим содержимым?`);
          if (!overwrite) throw new Error("Сохранение отменено — выбери другое имя файла.");
        }
        targetSha = existing.sha;
      }
    } catch (lookupError) {
      const msg = String(lookupError?.message || "");
      if (!/not found/i.test(msg)) throw lookupError;
    }
  }

  const body = {
    message: targetSha ? `Update ${path}` : `Create ${path}`,
    content: utf8ToBase64(markdownText),
    branch: state.branch,
  };
  if (targetSha) body.sha = targetSha;

  const result = await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (oldPath && path !== oldPath && currentSha) {
    await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(oldPath)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Rename ${oldPath} to ${path}`, sha: currentSha, branch: state.branch }),
    });
  }
  return { path, sha: result.content.sha };
}

async function saveCurrent() {
  const markdownText = getEditorMarkdown();
  const tab = activeTab();
  let requestedPath = (els.pathInput.value.trim() || tab?.path || "").trim();
  if (tab?.isNew) {
    const title = firstLineTitle(markdownText);
    if (title) {
      const folder = folderOf(requestedPath);
      const safeBase = title.replace(/[\\/:*?"<>|#\[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "Новая заметка";
      const prefix = folder ? `${folder}/` : "";
      let candidate = `${prefix}${safeBase}.md`;
      let n = 2;
      const occupied = p => state.files.some(f => f.path.toLowerCase() === p.toLowerCase()) || state.tabs.some(t => t.id !== tab.id && t.path?.toLowerCase() === p.toLowerCase());
      while (occupied(candidate)) candidate = `${prefix}${safeBase} ${n++}.md`;
      requestedPath = candidate;
      tab.path = candidate;
      els.pathInput.value = candidate;
    }
  }
  const oldPath = tab && !tab.isNew ? tab.path : null;
  const currentSha = tab?.sha || null;
  try {
    setSyncStatus("Сохранение…");
    const saved = await persistMarkdownFile({
      path: requestedPath, oldPath, currentSha, markdownText,
    });
    state.current = saved.path;
    state.currentSha = saved.sha;
    if (tab) {
      tab.path = saved.path;
      tab.sha = saved.sha;
      tab.text = markdownText;
      tab.savedText = markdownText;
      tab.isNew = false;
      tab.unloaded = false;
      tab.dirty = false;
    }
    updatePrimaryPathUI(saved.path);
    updateActiveNoteTitle(saved.path);
    state.contents.set(saved.path, { text: markdownText, sha: saved.sha });
    const fileEntry = { path: saved.path, sha: saved.sha, type: "blob" };
    const fileIndex = state.files.findIndex(f => f.path === saved.path);
    if (fileIndex >= 0) state.files[fileIndex] = { ...state.files[fileIndex], ...fileEntry };
    else state.files.push(fileEntry);
    if (!state.notes.some(n => n.path === saved.path)) state.notes.push(fileEntry);
    try { await loadTree(); } catch (treeError) { console.warn("Tree refresh after save failed", treeError); renderFileList(els.searchInput.value); }
    state.contents.set(saved.path, { text: markdownText, sha: saved.sha });
    await Promise.all([renderBacklinks(saved.path), renderOutgoing(markdownText)]);
    renderTabs();
    persistTabsWorkspace();
    setSyncStatus("Сохранено");
    showToast("Сохранено в GitHub.");
  } catch (e) {
    setSyncStatus("Ошибка сохранения");
    showToast(`Не сохранено: ${e.message}`);
  }
}

async function saveSecondary() {
  if (!state.secondary.path && !els.secondaryPathInput.value.trim()) return;
  const markdownText = getSecondaryMarkdown();
  try {
    setSyncStatus("Сохранение второй области…");
    const saved = await persistMarkdownFile({
      path: els.secondaryPathInput.value.trim(), oldPath: state.secondary.path, currentSha: state.secondary.sha, markdownText,
    });
    state.secondary.path = saved.path;
    state.secondary.sha = saved.sha;
    updateSecondaryPathUI(saved.path);
    els.secondaryNoteTitle.textContent = noteName(saved.path);
    state.contents.set(saved.path, { text: markdownText, sha: saved.sha });
    const fileEntry = { path: saved.path, sha: saved.sha, type: "blob" };
    const fileIndex = state.files.findIndex(f => f.path === saved.path);
    if (fileIndex >= 0) state.files[fileIndex] = { ...state.files[fileIndex], ...fileEntry };
    else state.files.push(fileEntry);
    if (!state.notes.some(n => n.path === saved.path)) state.notes.push(fileEntry);
    try { await loadTree(); } catch (treeError) { console.warn("Tree refresh after secondary save failed", treeError); renderFileList(els.searchInput.value); }
    state.contents.set(saved.path, { text: markdownText, sha: saved.sha });
    setSyncStatus("Сохранено");
    showToast("Вторая область сохранена в GitHub.");
  } catch (e) {
    setSyncStatus("Ошибка сохранения");
    showToast(`Не сохранено: ${e.message}`);
  }
}

function suggestedNewNotePath() {
  const folder = state.selectedFolder || folderOf(state.current) || "";
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const prefix = folder ? `${folder}/` : "";
  const base = `${prefix}Новая заметка ${yyyy}-${mo}-${dd} ${hh}-${mm}-${ss}-${ms}`;
  const taken = candidate => state.files.some(f => f.path === candidate) || state.tabs.some(t => t.path === candidate);
  let candidate = `${base}.md`;
  let n = 2;
  while (taken(candidate)) candidate = `${base} ${n++}.md`;
  return candidate;
}

function newNote(path = null) {
  // Snapshot the previous tab before changing activeTabId. This prevents a new tab
  // from inheriting the previous editor buffer.
  const previous = activeTab();
  if (previous) {
    const previousText = getEditorMarkdown();
    previous.text = previousText;
    previous.path = (els.pathInput.value || previous.path || "").trim();
    previous.sha = state.currentSha;
    previous.dirty = previous.isNew || previousText !== (previous.savedText ?? previousText);
  }

  path = path || suggestedNewNotePath();
  path = path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
  const tab = { id: `tab-${++state.tabSeq}`, path, sha: null, text: "", savedText: "", dirty: true, isNew: true, unloaded: false };
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  state.current = null;
  state.currentSha = null;
  state.activePane = "primary";
  els.primaryPane.classList.add("pane-active");
  els.secondaryPane.classList.remove("pane-active");
  updatePrimaryPathUI(path);
  setEditorMarkdown("");
  tab.text = "";
  tab.savedText = "";
  tab.dirty = true;
  els.emptyState.classList.add("hidden");
  els.editorView.classList.remove("hidden");
  els.backlinksList.textContent = "—";
  els.outgoingList.textContent = "—";
  setMode("notes");
  showPreview();
  els.sidebar.classList.remove("open");
  setSyncStatus("Новая заметка");
  renderTabs();
  persistTabsWorkspace();
  setTimeout(() => state.editorView?.focus(), 0);
}

async function createFolder(baseOverride = null) {
  const base = baseOverride !== null ? baseOverride : (state.selectedFolder || folderOf(state.current) || "");
  const raw = prompt("Название новой папки", base ? `${base}/Новая папка` : "Новая папка");
  if (!raw) return;
  const folder = raw.trim().replace(/^\/+|\/+$/g, "").replace(/\\/g, "/");
  if (!folder) return;
  try {
    setSyncStatus("Создание папки…");
    const keepPath = `${folder}/.gitkeep`;
    let sha = null;
    try { const existing = await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(keepPath)}?ref=${encodeURIComponent(state.branch)}`); sha = existing?.sha || null; } catch {}
    const body = { message: `Create folder ${folder}`, content: utf8ToBase64(""), branch: state.branch };
    if (sha) body.sha = sha;
    await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(keepPath)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    state.selectedFolder = folder;
    state.expandedFolders.add(folder);
    await loadTree();
    setSyncStatus("Готово");
    showToast(`Папка «${folder}» создана.`);
  } catch (e) { setSyncStatus("Ошибка"); showToast(`Не удалось создать папку: ${e.message}`); }
}


function normalizeRepoPath(path = "") {
  return String(path).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

async function copyRepoPath(path) {
  try { await navigator.clipboard.writeText(normalizeRepoPath(path)); showToast("Путь скопирован."); }
  catch { showToast(normalizeRepoPath(path)); }
}

async function getBlobBase64(sha) {
  const blob = await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/git/blobs/${encodeURIComponent(sha)}`);
  if (blob.encoding !== "base64") throw new Error("GitHub вернул неподдерживаемый формат файла.");
  return String(blob.content || "").replace(/\n/g, "");
}

async function putBase64File(path, content, message, overwriteSha = null) {
  const body = { message, content, branch: state.branch };
  if (overwriteSha) body.sha = overwriteSha;
  return gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(path)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

async function deleteRepoFile(path, sha, message) {
  return gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(path)}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, sha, branch: state.branch }),
  });
}

function existingFile(path) { return state.files.find(f => f.path === path) || null; }

async function relocateFile(oldPath, newPath, { copy = false } = {}) {
  oldPath = normalizeRepoPath(oldPath); newPath = normalizeRepoPath(newPath);
  if (!oldPath || !newPath || oldPath === newPath) return newPath || oldPath;
  const source = existingFile(oldPath);
  if (!source) throw new Error(`Файл ${oldPath} не найден.`);
  const target = existingFile(newPath);
  if (target && target.path !== oldPath && !confirm(`${newPath} уже существует. Заменить?`)) throw new Error("Операция отменена.");
  const content = await getBlobBase64(source.sha);
  await putBase64File(newPath, content, `${copy ? "Copy" : "Move"} ${oldPath} to ${newPath}`, target?.sha || null);
  if (!copy) await deleteRepoFile(oldPath, source.sha, `Remove old path ${oldPath}`);
  return newPath;
}

function fileToBase64(file) {
  return file.arrayBuffer().then(buf => {
    const bytes = new Uint8Array(buf); let binary = ""; const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
  });
}

function uniqueAssetPath(path) {
  if (!existingFile(path)) return path;
  const dot = path.lastIndexOf(".");
  const base = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
  const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
  let n = 2, candidate = `${base}-${n}${ext}`;
  while (existingFile(candidate)) candidate = `${base}-${++n}${ext}`;
  return candidate;
}


function extractImageEmbeds(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text || "").split("\n");
  for (const line of lines) {
    const obs = line.match(/!\[\[([^\]|]+?\.(?:png|jpe?g|gif|webp|svg|avif|bmp))(?:\|(\d+))?\]\]/i);
    const md = line.match(/!\[([^\]]*)\]\(([^)]+)\)/i);
    if (obs) {
      const key = `obs:${obs[1]}`;
      if (!seen.has(key)) { seen.add(key); out.push({ target: obs[1], alt: "", width: obs[2] || null }); }
    } else if (md) {
      const key = `md:${md[2]}`;
      if (!seen.has(key)) { seen.add(key); out.push({ target: md[2], alt: md[1] || "", width: null }); }
    }
  }
  return out;
}

async function renderMediaPreview(text, notePath, targetEl) {
  if (!targetEl) return;
  const embeds = extractImageEmbeds(text);
  const seq = (targetEl._renderSeq || 0) + 1;
  targetEl._renderSeq = seq;
  targetEl.innerHTML = "";
  targetEl.classList.toggle("hidden", !embeds.length);
  if (!embeds.length) return;

  for (const embed of embeds) {
    const figure = document.createElement("figure");
    figure.className = "media-preview-item";
    const status = document.createElement("div");
    status.className = "media-preview-status";
    status.textContent = "Загрузка изображения…";
    figure.appendChild(status);
    targetEl.appendChild(figure);

    try {
      const resolved = resolveImageRepoPath(embed.target, notePath);
      const url = resolved.external ? resolved.path : await privateImageUrl(resolved.path);
      if (targetEl._renderSeq !== seq) return;
      const img = document.createElement("img");
      img.alt = embed.alt || embed.target.split("/").pop() || "image";
      img.src = url;
      if (embed.width) img.style.maxWidth = `${Math.max(80, Math.min(1600, Number(embed.width) || 600))}px`;
      img.addEventListener("load", () => status.remove(), { once: true });
      img.addEventListener("error", () => {
        status.textContent = `Не удалось открыть ${embed.target}`;
        status.classList.add("error");
      }, { once: true });
      figure.appendChild(img);
      const caption = document.createElement("figcaption");
      caption.textContent = embed.target;
      figure.appendChild(caption);
    } catch (err) {
      status.textContent = err?.message || `Не удалось открыть ${embed.target}`;
      status.classList.add("error");
    }
  }
}

function requestImageInsert(pane = "primary") {
  state.imageTargetPane = pane;
  showToast("Выбери изображение…");
  const selection = pane === "secondary" ? secondarySelection() : currentSelection();
  const notePath = pane === "secondary"
    ? (els.secondaryPathInput.value.trim() || state.secondary.path || "")
    : (els.pathInput.value.trim() || state.current || "");
  state.imageInsertContext = { pane, start: selection.start, end: selection.end, notePath };
  els.imageInput.value = "";
  els.imageInput.click();
}

async function uploadImageForPane(file, pane = "primary") {
  if (!file) return;
  const context = state.imageInsertContext && state.imageInsertContext.pane === pane
    ? state.imageInsertContext
    : { pane, start: null, end: null, notePath: pane === "secondary" ? (state.secondary.path || "") : (state.current || "") };
  try {
    if (!/^image\//i.test(file.type || "") && !/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(file.name || "")) {
      throw new Error("Выбранный файл не похож на изображение.");
    }
    if (file.size > 50 * 1024 * 1024) throw new Error("Изображение больше 50 МБ. Сожми файл перед загрузкой.");
    setSyncStatus("Загрузка изображения…");
    const notePath = context.notePath || "";
    const baseFolder = folderOf(notePath) || state.selectedFolder || "";
    const safeName = (file.name || `image-${Date.now()}.png`).replace(/[\\/\[\]|#?%*:<>"'`]/g, "-").replace(/\s+/g, " ").trim();
    const path = uniqueAssetPath(`${baseFolder ? baseFolder + "/" : ""}attachments/${safeName}`);
    const b64 = await fileToBase64(file);
    const result = await putBase64File(path, b64, `Add image ${path}`);

    const uploaded = result?.content;
    if (uploaded?.sha) {
      const existingIndex = state.files.findIndex(f => f.path === path);
      const entry = { path, sha: uploaded.sha, type: "blob", size: uploaded.size || file.size };
      if (existingIndex >= 0) state.files[existingIndex] = { ...state.files[existingIndex], ...entry };
      else state.files.push(entry);
    }
    const oldUrl = state.mediaUrls.get(path);
    if (oldUrl?.startsWith?.("blob:")) URL.revokeObjectURL(oldUrl);
    state.mediaUrls.set(path, URL.createObjectURL(file));

    // Store the full repository path in the wiki embed. This keeps the image
    // valid even if the note is later moved to another folder.
    const markdown = `![[${path}|520]]`;
    if (pane === "secondary") {
      const sel = context.start == null ? secondarySelection() : context;
      replaceSecondaryRange(sel.start, sel.end, markdown, sel.start + markdown.length);
    } else {
      const sel = context.start == null ? currentSelection() : context;
      replaceEditorRange(sel.start, sel.end, markdown, sel.start + markdown.length);
    }
    setSyncStatus("Готово");
    showToast("Изображение загружено и вставлено.");
    // Refresh the tree after insertion, but don't block the editor on GitHub tree propagation.
    setTimeout(() => loadTree().catch(() => {}), 700);
  } catch (e) {
    setSyncStatus("Ошибка");
    showToast(`Не удалось вставить изображение: ${e.message}`);
  } finally {
    state.imageInsertContext = null;
    els.imageInput.value = "";
  }
}

async function moveNoteToFolder(path, folder) {
  folder = normalizeRepoPath(folder || "");
  const filename = path.split("/").pop();
  const newPath = folder ? `${folder}/${filename}` : filename;
  if (newPath === path) return;
  await performNoteRelocation(path, newPath, false);
}

async function renameNoteFile(path) {
  const currentName = noteName(path);
  const raw = prompt("Новое имя заметки", currentName);
  if (!raw) return;
  const clean = raw.trim().replace(/[\\/]/g, "-");
  if (!clean) return;
  const newPath = `${folderOf(path) ? folderOf(path) + "/" : ""}${clean}${clean.toLowerCase().endsWith(".md") ? "" : ".md"}`;
  await performNoteRelocation(path, newPath, false);
}

async function moveNoteFile(path) {
  const raw = prompt("Новый путь заметки", path);
  if (!raw) return;
  let newPath = normalizeRepoPath(raw);
  if (!newPath.toLowerCase().endsWith(".md")) newPath += ".md";
  await performNoteRelocation(path, newPath, false);
}

async function duplicateNoteFile(path) {
  const base = path.replace(/\.md$/i, "");
  const raw = prompt("Путь копии", `${base} — копия.md`);
  if (!raw) return;
  let newPath = normalizeRepoPath(raw);
  if (!newPath.toLowerCase().endsWith(".md")) newPath += ".md";
  await performNoteRelocation(path, newPath, true);
}

async function performNoteRelocation(oldPath, newPath, copy = false) {
  try {
    setSyncStatus(copy ? "Копирование…" : "Перемещение…");
    const finalPath = await relocateFile(oldPath, newPath, { copy });
    const primaryWas = state.current === oldPath;
    const secondaryWas = state.secondary.path === oldPath;
    if (!copy) {
      for (const tab of state.tabs) if (tab.path === oldPath) tab.path = finalPath;
      const active = activeTab();
      if (active?.path === finalPath) updateActiveNoteTitle(finalPath);
      persistTabsWorkspace();
    }
    await loadTree();
    if (!copy) {
      const newSha = existingFile(finalPath)?.sha || null;
      for (const tab of state.tabs) if (tab.path === finalPath) tab.sha = newSha;
      if (primaryWas) { state.current = finalPath; state.currentSha = newSha; updatePrimaryPathUI(finalPath); updateActiveNoteTitle(finalPath); }
      if (secondaryWas) { state.secondary.path = finalPath; state.secondary.sha = newSha; updateSecondaryPathUI(finalPath); els.secondaryNoteTitle.textContent = noteName(finalPath); }
      renderTabs(); persistTabsWorkspace(); renderFileList(els.searchInput.value);
    }
    if (!copy && primaryWas) { await Promise.all([renderBacklinks(finalPath), renderOutgoing(getEditorMarkdown())]); }
    else if (!copy && secondaryWas) await openInSplit(finalPath, state.splitOrientation, false);
    setSyncStatus("Готово");
    showToast(copy ? "Копия создана." : "Готово.");
  } catch (e) { setSyncStatus("Ошибка"); showToast(e.message || "Операция не выполнена."); }
}

async function deleteNoteFile(path) {
  if (!confirm(`Удалить заметку «${noteName(path)}»? Это удалит файл из vault.`)) return;
  try {
    const file = existingFile(path); if (!file) throw new Error("Файл не найден.");
    await deleteRepoFile(path, file.sha, `Delete ${path}`);
    const tabToRemove = state.tabs.find(t => t.path === path);
    if (tabToRemove) state.tabs = state.tabs.filter(t => t.id !== tabToRemove.id);
    if (state.current === path) { state.current = null; state.currentSha = null; state.activeTabId = state.tabs[0]?.id || null; els.editorView.classList.add("hidden"); els.emptyState.classList.remove("hidden"); updateActiveNoteTitle(null); }
    if (state.secondary.path === path) closeSplit();
    renderTabs(); persistTabsWorkspace();
    await loadTree();
    showToast("Заметка удалена.");
  } catch (e) { showToast(`Не удалось удалить: ${e.message}`); }
}

async function relocateFolder(oldFolder, newFolder) {
  oldFolder = normalizeRepoPath(oldFolder); newFolder = normalizeRepoPath(newFolder);
  if (!oldFolder || !newFolder || oldFolder === newFolder) return;
  if (newFolder.startsWith(oldFolder + "/")) throw new Error("Нельзя переместить папку внутрь самой себя.");
  const items = state.files.filter(f => f.path === oldFolder || f.path.startsWith(oldFolder + "/"));
  if (!items.length) throw new Error("Папка пуста или не найдена.");
  const targets = items.map(f => ({ source: f, path: newFolder + f.path.slice(oldFolder.length) }));
  const conflicts = targets.filter(t => existingFile(t.path) && !items.some(i => i.path === t.path));
  if (conflicts.length) throw new Error(`В папке назначения уже есть ${conflicts.length} конфликтующих файлов.`);
  setSyncStatus("Перемещение папки…");
  for (const item of targets) {
    const content = await getBlobBase64(item.source.sha);
    await putBase64File(item.path, content, `Move ${item.source.path} to ${item.path}`);
  }
  for (const item of items.slice().reverse()) await deleteRepoFile(item.path, item.sha, `Remove old path ${item.path}`);
  const mapPath = p => p && (p === oldFolder || p.startsWith(oldFolder + "/")) ? newFolder + p.slice(oldFolder.length) : p;
  const oldPrimary = state.current, oldSecondary = state.secondary.path;
  state.current = mapPath(state.current); state.secondary.path = mapPath(state.secondary.path); state.selectedFolder = newFolder;
  for (const tab of state.tabs) tab.path = mapPath(tab.path);
  persistTabsWorkspace(); renderTabs();
  state.expandedFolders = new Set(Array.from(state.expandedFolders).map(mapPath));
  await loadTree();
  if (oldPrimary && oldPrimary !== state.current) await openNote(state.current);
  if (oldSecondary && oldSecondary !== state.secondary.path && els.paneHost.classList.contains("split-active")) await openInSplit(state.secondary.path, state.splitOrientation, false);
  setSyncStatus("Готово");
}

async function renameFolder(path) {
  const parts = normalizeRepoPath(path).split("/"); const oldName = parts.pop(); const parent = parts.join("/");
  const raw = prompt("Новое имя папки", oldName); if (!raw) return;
  const name = raw.trim().replace(/[\\/]/g, "-"); if (!name) return;
  try { await relocateFolder(path, `${parent ? parent + "/" : ""}${name}`); showToast("Папка переименована."); }
  catch (e) { setSyncStatus("Ошибка"); showToast(e.message); }
}

async function moveFolderPrompt(path) {
  const oldName = normalizeRepoPath(path).split("/").pop();
  const raw = prompt("Папка назначения (оставь пустым для корня)", folderOf(path)); if (raw === null) return;
  const parent = normalizeRepoPath(raw);
  try { await relocateFolder(path, `${parent ? parent + "/" : ""}${oldName}`); showToast("Папка перемещена."); }
  catch (e) { setSyncStatus("Ошибка"); showToast(e.message); }
}

async function deleteFolder(path) {
  const folder = normalizeRepoPath(path);
  const items = state.files.filter(f => f.path.startsWith(folder + "/"));
  if (!items.length) return showToast("Папка уже пуста.");
  if (!confirm(`Удалить папку «${folder}» и все файлы внутри (${items.length})?`)) return;
  try {
    setSyncStatus("Удаление папки…");
    for (const item of items.slice().reverse()) await deleteRepoFile(item.path, item.sha, `Delete ${item.path}`);

    const removedTabIds = new Set(state.tabs.filter(t => t.path?.startsWith(folder + "/")).map(t => t.id));
    const activeWasRemoved = removedTabIds.has(state.activeTabId);
    state.tabs = state.tabs.filter(t => !removedTabIds.has(t.id));

    if (state.secondary.path?.startsWith(folder + "/")) closeSplit();
    state.selectedFolder = "";
    await loadTree();

    if (activeWasRemoved || state.current?.startsWith(folder + "/")) {
      const fallback = state.tabs[0] || null;
      if (fallback) await activateTab(fallback.id);
      else {
        state.activeTabId = null; state.current = null; state.currentSha = null;
        els.editorView.classList.add("hidden"); els.emptyState.classList.remove("hidden");
        updateActiveNoteTitle(null); renderTabs();
        els.backlinksList.textContent = "—"; els.outgoingList.textContent = "—";
      }
    } else renderTabs();
    persistTabsWorkspace();
    setSyncStatus("Готово"); showToast("Папка удалена.");
  } catch (e) { setSyncStatus("Ошибка"); showToast(`Не удалось удалить папку: ${e.message}`); }
}

function createFromMissingLink(target) {
  const clean = normalizeWikiTarget(target);
  if (!clean) return;
  const prefix = state.selectedFolder ? `${state.selectedFolder}/` : "";
  const path = clean.includes("/") ? `${clean}.md` : `${prefix}${clean}.md`;
  newNote(path);
  showToast(`Новая заметка для [[${clean}]] — нажми «Сохранить».`);
}

async function renderBacklinks(currentPath) {
  const name = noteName(currentPath);
  const pathNoExt = currentPath.replace(/\.md$/i, "");
  const matches = [];

  for (const note of state.notes) {
    if (note.path === currentPath) continue;
    try {
      const item = await getFile(note.path);
      const links = extractWikiLinks(item.text);
      if (links.some(link => link.target === pathNoExt || link.target.toLowerCase() === name.toLowerCase())) matches.push(note.path);
    } catch {}
  }

  els.backlinksList.innerHTML = "";
  if (!matches.length) {
    els.backlinksList.textContent = "Нет ссылок на эту заметку.";
    return;
  }

  for (const path of matches) {
    const div = document.createElement("div");
    div.className = "backlink";
    div.textContent = `← ${path}`;
    div.onclick = () => openNote(path);
    els.backlinksList.appendChild(div);
  }
}

async function renderOutgoing(text) {
  const links = extractWikiLinks(text);
  els.outgoingList.innerHTML = "";
  if (!links.length) {
    els.outgoingList.textContent = "Нет ссылок из этой заметки.";
    return;
  }

  const seen = new Set();
  for (const link of links) {
    if (seen.has(link.target)) continue;
    seen.add(link.target);
    const path = wikiTargetToPath(link.raw);
    const div = document.createElement("div");
    div.className = `backlink ${path ? "" : "missing"}`;
    div.textContent = path ? `→ ${path}` : `→ [[${link.target}]] (не создана)`;
    div.onclick = () => path ? openNote(path) : createFromMissingLink(link.raw);
    els.outgoingList.appendChild(div);
  }
}

function currentSelection() {
  if (state.editorMode === "live" && state.editorView) {
    const sel = state.editorView.state.selection.main;
    return { text: state.editorView.state.doc.toString(), start: sel.from, end: sel.to, cursor: sel.head };
  }
  return { text: els.editorText.value, start: els.editorText.selectionStart, end: els.editorText.selectionEnd, cursor: els.editorText.selectionStart };
}

function replaceEditorRange(from, to, insert, cursor = from + insert.length, selectFrom = null, selectTo = null) {
  if (state.editorMode === "live" && state.editorView) {
    const selection = selectFrom == null ? { anchor: cursor } : { anchor: selectFrom, head: selectTo };
    state.editorView.dispatch({ changes: { from, to, insert }, selection, scrollIntoView: true });
    state.editorView.focus();
  } else {
    els.editorText.setRangeText(insert, from, to, "start");
    if (selectFrom == null) els.editorText.setSelectionRange(cursor, cursor);
    else els.editorText.setSelectionRange(selectFrom, selectTo);
    els.editorText.focus();
    els.editorText.dispatchEvent(new Event("input"));
  }
}

function replaceSelection(before, after = before, placeholder = "текст") {
  const sel = currentSelection();
  const selected = sel.text.slice(sel.start, sel.end) || placeholder;
  const insert = `${before}${selected}${after}`;
  const selectedFrom = sel.start + before.length;
  const selectedTo = selectedFrom + selected.length;
  replaceEditorRange(sel.start, sel.end, insert, selectedTo, selectedFrom, selectedTo);
}

function requestHighlightColor(pane = "primary") {
  const sel = pane === "secondary" ? secondarySelection() : currentSelection();
  state.highlightTargetPane = pane;
  state.highlightInsertContext = { pane, start: sel.start, end: sel.end, text: sel.text.slice(sel.start, sel.end) };
  els.highlightColorInput.value = els.highlightColorInput.value || "#ffd84d";
  try {
    if (typeof els.highlightColorInput.showPicker === "function") els.highlightColorInput.showPicker();
    else els.highlightColorInput.click();
  } catch {
    els.highlightColorInput.click();
  }
}

function applyHighlightColor(color) {
  const ctx = state.highlightInsertContext;
  if (!ctx || !/^#[0-9a-fA-F]{6}$/.test(color || "")) return;
  document.documentElement.style.setProperty("--note-highlight", color);
  try { localStorage.setItem("pv_highlight_color", color); } catch {}
  const selected = ctx.text || "выделенный текст";
  const insert = `=={${color}}${selected}==`;
  const innerStart = ctx.start + 11;
  const innerEnd = innerStart + selected.length;
  if (ctx.pane === "secondary") replaceSecondaryRange(ctx.start, ctx.end, insert, innerEnd, innerStart, innerEnd);
  else replaceEditorRange(ctx.start, ctx.end, insert, innerEnd, innerStart, innerEnd);
  state.highlightInsertContext = null;
}


function insertExternalLink(pane = "primary") {
  const sel = pane === "secondary" ? secondarySelection() : currentSelection();
  const selected = sel.text.slice(sel.start, sel.end);
  let url = prompt("Адрес ссылки", "https://");
  if (!url) return;
  url = url.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("#") && !url.startsWith("/")) url = `https://${url}`;
  let label = selected;
  if (!label) {
    try { label = new URL(url).hostname.replace(/^www\./, ""); } catch { label = url; }
    const custom = prompt("Текст ссылки", label);
    if (custom === null) return;
    label = custom.trim() || label;
  }
  const insert = `[${label}](${url})`;
  if (pane === "secondary") replaceSecondaryRange(sel.start, sel.end, insert, sel.start + insert.length);
  else replaceEditorRange(sel.start, sel.end, insert, sel.start + insert.length);
}

function prefixSelectedLines(prefixer, selectResult = true) {
  const sel = currentSelection();
  const text = sel.text;
  const lineStart = text.lastIndexOf("\n", Math.max(0, sel.start - 1)) + 1;
  let lineEnd = text.indexOf("\n", sel.end);
  if (lineEnd === -1) lineEnd = text.length;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n").map((line, i) => `${prefixer(i)}${line}`).join("\n");
  if (selectResult) replaceEditorRange(lineStart, lineEnd, lines, lineStart + lines.length, lineStart, lineStart + lines.length);
  else replaceEditorRange(lineStart, lineEnd, lines, lineStart + lines.length);
}

function insertAtCursor(text, cursorOffset = text.length) {
  const sel = currentSelection();
  replaceEditorRange(sel.start, sel.end, text, sel.start + cursorOffset);
}

function toolbarAction(action) {
  if (action === "undo") {
    if (state.editorMode === "live" && state.editorView) return undo(state.editorView);
    document.execCommand("undo"); return;
  }
  if (action === "redo") {
    if (state.editorMode === "live" && state.editorView) return redo(state.editorView);
    document.execCommand("redo"); return;
  }
  if (action === "bold") return replaceSelection("**", "**", "жирный текст");
  if (action === "italic") return replaceSelection("*", "*", "курсив");
  if (action === "strike") return replaceSelection("~~", "~~", "зачёркнутый текст");
  if (action === "underline") return replaceSelection("<u>", "</u>", "подчёркнутый текст");
  if (action === "highlight") return requestHighlightColor("primary");
  if (action === "wiki") {
    const sel = currentSelection();
    const selected = sel.text.slice(sel.start, sel.end).trim();
    const target = selected || prompt("Название заметки", "");
    if (!target) return;
    const insert = `[[${target}]]`;
    replaceEditorRange(sel.start, sel.end, insert, sel.start + insert.length);
    return;
  }
  if (action === "link") return insertExternalLink("primary");
  if (action === "image") return requestImageInsert("primary");
  if (action === "hr") return insertAtCursor("\n---\n");
  if (action === "fullscreen") { document.body.classList.toggle("focus-mode"); return; }
  if (action === "h1") return prefixSelectedLines(() => "# ");
  if (action === "h2") return prefixSelectedLines(() => "## ");
  if (action === "h3") return prefixSelectedLines(() => "### ");
  if (action === "bullet") return prefixSelectedLines(() => "- ");
  if (action === "numbered") return prefixSelectedLines(i => `${i + 1}. `);
  if (action === "todo") return prefixSelectedLines(() => "- [ ] ", false);
  if (action === "quote") return prefixSelectedLines(() => "> ");
}

function activeWikiQuery() {
  if (state.editorMode === "live" && state.editorView) {
    const sel = state.editorView.state.selection.main;
    if (sel.from !== sel.to) return null;
    const cursor = sel.head;
    const line = state.editorView.state.doc.lineAt(cursor);
    const before = state.editorView.state.doc.sliceString(line.from, cursor);
    const open = before.lastIndexOf("[[");
    if (open === -1) return null;
    const close = before.lastIndexOf("]]" );
    if (close > open) return null;
    const query = before.slice(open + 2);
    if (query.length > 100) return null;
    return { query, start: line.from + open, end: cursor };
  }
  const cursor = els.editorText.selectionStart;
  if (cursor !== els.editorText.selectionEnd) return null;
  const lineStart = els.editorText.value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const before = els.editorText.value.slice(lineStart, cursor);
  const open = before.lastIndexOf("[[");
  if (open === -1) return null;
  const close = before.lastIndexOf("]]" );
  if (close > open) return null;
  const query = before.slice(open + 2);
  if (query.length > 100) return null;
  return { query, start: lineStart + open, end: cursor };
}

function positionWikiSuggestions() {
  const body = els.wikiSuggest.parentElement;
  if (state.editorMode === "live" && state.editorView && state.wikiRange) {
    const coords = state.editorView.coordsAtPos(state.wikiRange.end);
    const rect = body.getBoundingClientRect();
    if (coords) {
      const left = Math.max(8, Math.min(coords.left - rect.left, rect.width - Math.min(420, rect.width - 16)));
      const top = Math.max(8, coords.bottom - rect.top + 6);
      els.wikiSuggest.style.left = `${left}px`;
      els.wikiSuggest.style.top = `${top}px`;
      return;
    }
  }
  els.wikiSuggest.style.left = "18px";
  els.wikiSuggest.style.top = "12px";
}

let wikiSuggestFrame = 0;
function scheduleWikiSuggestions() {
  cancelAnimationFrame(wikiSuggestFrame);
  wikiSuggestFrame = requestAnimationFrame(() => {
    wikiSuggestFrame = 0;
    updateWikiSuggestions();
  });
}

function updateWikiSuggestions() {
  const ctx = activeWikiQuery();
  if (!ctx) return hideWikiSuggestions();
  const q = ctx.query.split("|")[0].split("#")[0].trim().toLowerCase();
  const ranked = state.notes
    .map(n => ({ path: n.path, name: noteName(n.path) }))
    .filter(n => !q || n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
    .sort((a, b) => {
      const ae = a.name.toLowerCase() === q ? -2 : a.name.toLowerCase().startsWith(q) ? -1 : 0;
      const be = b.name.toLowerCase() === q ? -2 : b.name.toLowerCase().startsWith(q) ? -1 : 0;
      return ae - be || a.name.localeCompare(b.name, "ru");
    })
    .slice(0, 12);

  state.wikiSuggestions = ranked;
  state.wikiSelected = Math.min(state.wikiSelected, Math.max(0, ranked.length - 1));
  state.wikiRange = ctx;

  if (!ranked.length) return hideWikiSuggestions(false);
  els.wikiSuggest.innerHTML = "";
  ranked.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.className = `wiki-option ${i === state.wikiSelected ? "selected" : ""}`;
    btn.innerHTML = `<strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.path)}</small>`;
    btn.onmousedown = e => { e.preventDefault(); chooseWikiSuggestion(i); };
    els.wikiSuggest.appendChild(btn);
  });
  positionWikiSuggestions();
  els.wikiSuggest.classList.remove("hidden");
}

function hideWikiSuggestions(clear = true) {
  els.wikiSuggest.classList.add("hidden");
  els.wikiSuggest.innerHTML = "";
  if (clear) {
    state.wikiSuggestions = [];
    state.wikiRange = null;
    state.wikiSelected = 0;
  }
}

function chooseWikiSuggestion(index = state.wikiSelected) {
  const item = state.wikiSuggestions[index];
  const range = state.wikiRange;
  if (!item || !range) return;
  const target = item.path.replace(/\.md$/i, "");
  const insert = `[[${target}]]`;
  replaceEditorRange(range.start, range.end, insert, range.start + insert.length);
  hideWikiSuggestions();
}

function handleEditorKeydown(e) {
  if (!els.wikiSuggest.classList.contains("hidden")) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.wikiSelected = (state.wikiSelected + 1) % state.wikiSuggestions.length;
      updateWikiSuggestions();
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      state.wikiSelected = (state.wikiSelected - 1 + state.wikiSuggestions.length) % state.wikiSuggestions.length;
      updateWikiSuggestions();
      return true;
    }
    if ((e.key === "Enter" || e.key === "Tab") && state.wikiSuggestions.length) {
      e.preventDefault();
      chooseWikiSuggestion();
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideWikiSuggestions();
      return true;
    }
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveCurrent();
    return true;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
    e.preventDefault();
    toolbarAction("bold");
    return true;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
    e.preventDefault();
    toolbarAction("italic");
    return true;
  }
  return false;
}

function setMode(mode) {
  state.mode = mode;
  const graph = mode === "graph";
  els.notesWorkspace.classList.toggle("hidden", graph);
  els.graphWorkspace.classList.toggle("hidden", !graph);
  els.notesModeBtn.classList.toggle("active", !graph);
  els.graphModeBtn.classList.toggle("active", graph);
  if (graph) {
    els.sidebar.classList.remove("open");
    buildGraph();
  } else if (state.graph.ambientFrame) {
    cancelAnimationFrame(state.graph.ambientFrame);
    state.graph.ambientFrame = null;
  }
}


async function buildGraph(forceReload = false) {
  if (!window.d3) return showToast("D3 не загрузился — проверь интернет-соединение.");
  els.graphLoading.classList.remove("hidden");
  try {
    // Always refresh the repository tree before building the graph so every
    // saved Markdown note is represented, including files created on another device.
    await loadTree();

    const entries = new Map();
    for (const note of state.notes) entries.set(note.path, { path: note.path, text: null });
    for (const tab of state.tabs) {
      if (!tab.path || !tab.path.toLowerCase().endsWith(".md")) continue;
      const prev = entries.get(tab.path) || { path: tab.path, text: null };
      prev.text = tab.text ?? prev.text;
      entries.set(tab.path, prev);
    }

    const all = Array.from(entries.values());
    const existingIds = new Set(all.map(n => n.path.replace(/\.md$/i, "")));
    const nameToId = new Map(all.map(n => [noteName(n.path).toLowerCase(), n.path.replace(/\.md$/i, "")]));
    const nodesMap = new Map();
    const links = [];

    for (const note of all) {
      const id = note.path.replace(/\.md$/i, "");
      nodesMap.set(id, { id, path: note.path, label: noteName(note.path), missing: false, degree: 0 });
    }

    const contents = await Promise.all(all.map(async note => {
      if (note.text != null) return [note.path, note.text];
      try {
        const item = await fetchFileFresh(note.path);
        return [note.path, item.text || ""];
      } catch {
        return [note.path, ""];
      }
    }));

    for (const [path, text] of contents) {
      const source = path.replace(/\.md$/i, "");
      const seenTargets = new Set();
      for (const linkInfo of extractWikiLinks(text || "")) {
        const candidate = linkInfo.target;
        const resolved = existingIds.has(candidate) ? candidate : nameToId.get(candidate.toLowerCase());
        const target = resolved || candidate;
        if (!target || seenTargets.has(target)) continue;
        seenTargets.add(target);
        if (!nodesMap.has(target)) nodesMap.set(target, { id: target, path: null, label: target.split("/").pop(), missing: true, degree: 0 });
        links.push({ source, target });
      }
    }

    for (const edge of links) {
      nodesMap.get(edge.source) && nodesMap.get(edge.source).degree++;
      nodesMap.get(edge.target) && nodesMap.get(edge.target).degree++;
    }

    const showMissing = els.showMissingToggle.checked;
    const nodes = Array.from(nodesMap.values()).filter(n => showMissing || !n.missing);
    const allowed = new Set(nodes.map(n => n.id));
    const visibleLinks = links.filter(l => allowed.has(typeof l.source === "string" ? l.source : l.source.id) && allowed.has(typeof l.target === "string" ? l.target : l.target.id));

    state.graph.nodes = nodes;
    state.graph.links = visibleLinks;
    renderGraph(nodes, visibleLinks);
    els.graphStats.textContent = ` · ${nodes.filter(n => !n.missing).length} заметок · ${visibleLinks.length} связей`;
  } catch (e) {
    showToast(`Граф: ${e.message}`);
  } finally {
    els.graphLoading.classList.add("hidden");
  }
}

function renderGraph(nodes, links) {
  const svg = d3.select(els.graphSvg);
  svg.selectAll("*").remove();
  if (state.graph.simulation) state.graph.simulation.stop();
  if (state.graph.ambientFrame) {
    cancelAnimationFrame(state.graph.ambientFrame);
    state.graph.ambientFrame = null;
  }

  const rect = els.graphSvg.getBoundingClientRect();
  const width = Math.max(320, rect.width || 900);
  const height = Math.max(320, rect.height || 650);
  svg.attr("viewBox", [0, 0, width, height]);

  const root = svg.append("g");
  const link = root.append("g").attr("class", "graph-links").selectAll("line").data(links).join("line")
    .attr("class", "graph-link")
    .attr("stroke-width", d => 0.9 + Math.min(1.15, (((d.source.degree || 0) + (d.target.degree || 0)) / 28)));

  const node = root.append("g").attr("class", "graph-nodes").selectAll("g").data(nodes, d => d.id).join("g")
    .attr("class", d => `graph-node ${d.missing ? "missing" : ""}`)
    .style("cursor", d => d.missing ? "default" : "grab");

  node.append("circle").attr("r", d => 5 + Math.min(8, Math.sqrt(d.degree || 0) * 1.8));
  node.append("text").attr("x", d => 9 + Math.min(8, Math.sqrt(d.degree || 0) * 1.8)).attr("y", 4).text(d => d.label);

  // Deterministic initial positions avoid the first-frame jump.
  const radius = Math.min(width, height) * 0.28;
  nodes.forEach((d, i) => {
    const savedPos = state.graph.positions.get(d.id);
    if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)) {
      d.x = savedPos.x; d.y = savedPos.y;
      if (savedPos.fixed) { d.fx = savedPos.x; d.fy = savedPos.y; }
    } else if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) {
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      d.x = width / 2 + Math.cos(a) * radius;
      d.y = height / 2 + Math.sin(a) * radius;
    }
    d._dragMoved = false;
  });

  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(105).strength(.22))
    .force("charge", d3.forceManyBody().strength(d => -105 - Math.min(150, (d.degree || 0) * 8)))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius(d => 24 + Math.min(18, (d.degree || 0) * 1.5)).strength(.86))
    .velocityDecay(.48)
    .alphaDecay(.045);

  const draw = () => {
    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);
    node.attr("transform", d => `translate(${d.x},${d.y})`);
    for (const d of nodes) if (Number.isFinite(d.x) && Number.isFinite(d.y)) {
      const prev = state.graph.positions.get(d.id) || {};
      state.graph.positions.set(d.id, { x: d.x, y: d.y, fixed: prev.fixed || false });
    }
  };
  simulation.on("tick", draw);
  draw();


  const drag = d3.drag()
    .container(root.node())
    .clickDistance(5)
    .on("start", (event, d) => {
      event.sourceEvent?.stopPropagation?.();
      d._dragMoved = false;
      d._dragStartX = event.x;
      d._dragStartY = event.y;
      d.fx = d.x;
      d.fy = d.y;
      if (!event.active) simulation.alphaTarget(.12).restart();
      d3.select(event.sourceEvent?.currentTarget || null).style?.("cursor", "grabbing");
    })
    .on("drag", (event, d) => {
      if (Math.hypot(event.x - d._dragStartX, event.y - d._dragStartY) > 3) d._dragMoved = true;
      d.fx = event.x;
      d.fy = event.y;
      d.x = event.x;
      d.y = event.y;
      draw();
    })
    .on("end", (event, d) => {
      d.fx = d.x;
      d.fy = d.y;
      state.graph.positions.set(d.id, { x: d.x, y: d.y, fixed: true });
      if (!event.active) simulation.alphaTarget(0);
      setTimeout(() => { d._dragMoved = false; }, 180);
    });
  node.call(drag);

  node.on("click", (event, d) => {
    if (d._dragMoved || !d.path) return;
    event.preventDefault();
    event.stopPropagation();
    setMode("notes");
    openNoteInActivePane(d.path);
  });

  node.on("dblclick", (event, d) => {
    event.preventDefault();
    event.stopPropagation();
    d.fx = null;
    d.fy = null;
    state.graph.positions.set(d.id, { x: d.x, y: d.y, fixed: false });
    simulation.alpha(.16).restart();
  });

  const zoom = d3.zoom().scaleExtent([0.12, 5]).on("zoom", event => root.attr("transform", event.transform));
  svg.call(zoom).on("dblclick.zoom", null);

  state.graph.simulation = simulation;
  state.graph.zoom = zoom;
  state.graph.svg = svg;
  state.graph.root = root;
  state.graph.nodeSelection = node;
  state.graph.linkSelection = link;
  applyGraphSearch();
}

function fitGraph(animate = true) {
  const { svg, zoom, root } = state.graph;
  if (!svg || !zoom || !root) return;
  const bounds = root.node().getBBox();
  if (!bounds.width || !bounds.height) return;
  const rect = els.graphSvg.getBoundingClientRect();
  const width = rect.width || 900;
  const height = rect.height || 650;
  const scale = Math.min(2, 0.88 / Math.max(bounds.width / width, bounds.height / height));
  const tx = width / 2 - scale * (bounds.x + bounds.width / 2);
  const ty = height / 2 - scale * (bounds.y + bounds.height / 2);
  const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);
  (animate ? svg.transition().duration(400) : svg).call(zoom.transform, transform);
}

function applyGraphSearch() {
  const q = els.graphSearch.value.trim().toLowerCase();
  const node = state.graph.nodeSelection;
  const link = state.graph.linkSelection;
  if (!node || !link) return;
  if (!q) {
    node.classed("dim", false).classed("highlight", false);
    link.classed("dim", false);
    return;
  }
  const matches = new Set(state.graph.nodes.filter(n => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).map(n => n.id));
  node.classed("dim", d => !matches.has(d.id)).classed("highlight", d => matches.has(d.id));
  link.classed("dim", d => !matches.has(d.source.id || d.source) && !matches.has(d.target.id || d.target));
}

async function importVault(fileList) {
  const files = Array.from(fileList)
    .filter(f => !f.webkitRelativePath.includes("/.git/"))
    .filter(f => !f.webkitRelativePath.includes("/.obsidian/workspace"))
    .filter(f => f.size <= 90 * 1024 * 1024);

  if (!files.length) return;

  if (!confirm(`Импортировать ${files.length} файлов в ${state.owner}/${state.repo}? Файлы с тем же путём будут обновлены.`)) {
    els.vaultImport.value = "";
    return;
  }

  const rootPrefix = commonRoot(files.map(f => f.webkitRelativePath || f.name));
  let done = 0;

  for (const file of files) {
    const raw = file.webkitRelativePath || file.name;
    let path = raw;
    if (rootPrefix && path.startsWith(rootPrefix)) path = path.slice(rootPrefix.length);
    if (!path || path.startsWith(".obsidian/")) continue;

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const content = btoa(binary);

      let sha = null;
      try {
        const existing = await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(state.branch)}`);
        sha = existing.sha;
      } catch {}

      const body = {
        message: `Import from Obsidian: ${path}`,
        content,
        branch: state.branch,
      };
      if (sha) body.sha = sha;

      await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(path)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      done++;
      showToast(`Импорт: ${done}/${files.length}`);
    } catch (e) {
      console.error("Import failed", path, e);
      showToast(`Ошибка импорта: ${path}`);
    }
  }

  els.vaultImport.value = "";
  await loadTree();
  showToast(`Импортировано файлов: ${done}`);
}

function commonRoot(paths) {
  if (!paths.length) return "";
  const first = paths[0].split("/");
  if (first.length < 2) return "";
  const root = first[0] + "/";
  return paths.every(p => p.startsWith(root)) ? root : "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function logout() {
  sessionStorage.removeItem("pv_owner");
  sessionStorage.removeItem("pv_repo");
  sessionStorage.removeItem("pv_token");
  location.reload();
}

els.connectBtn.onclick = connect;
els.searchInput.oninput = e => renderFileList(e.target.value);
els.previewBtn.onclick = showPreview;
els.editBtn.onclick = showEditor;
els.saveBtn.onclick = saveCurrent;
els.newBtn.onclick = () => newNote();
els.newTabBtn.onclick = () => newNote();
els.newNoteSidebarBtn.onclick = () => newNote();
els.newFolderBtn.onclick = () => createFolder();
els.logoutBtn.onclick = logout;
els.vaultImport.onchange = e => importVault(e.target.files);
els.imageInput.onchange = e => uploadImageForPane(e.target.files?.[0], state.imageTargetPane);
els.highlightColorInput.onchange = e => applyHighlightColor(e.target.value);
els.menuBtn.onclick = toggleSidebar;
els.searchRibbonBtn.onclick = () => {
  setMode("notes");
  if (window.matchMedia("(max-width: 980px)").matches) els.sidebar.classList.add("open");
  else els.appView.classList.remove("sidebar-collapsed");
  setTimeout(() => els.searchInput.focus(), 0);
};
els.rightPanelBtn.onclick = toggleContextSidebar;
els.notesModeBtn.onclick = () => {
  setMode("notes");
  if (window.matchMedia("(max-width: 980px)").matches) els.sidebar.classList.add("open");
};
els.graphModeBtn.onclick = () => setMode("graph");
els.graphRefreshBtn.onclick = () => buildGraph(true);
els.graphFitBtn.onclick = () => fitGraph();
els.graphSearch.oninput = applyGraphSearch;
els.showMissingToggle.onchange = () => buildGraph();
els.formatToolbar.addEventListener("click", e => {
  const btn = e.target.closest("[data-action]");
  if (btn) toolbarAction(btn.dataset.action);
});
els.splitBtn.onclick = () => showSplitMenu();
els.secondaryPreviewBtn.onclick = showSecondaryPreview;
els.secondaryEditBtn.onclick = showSecondaryEditor;
els.secondarySaveBtn.onclick = saveSecondary;
els.secondaryCloseBtn.onclick = closeSplit;
els.secondaryFormatToolbar.addEventListener("click", e => {
  const btn = e.target.closest("[data-secondary-action]");
  if (btn) secondaryToolbarAction(btn.dataset.secondaryAction);
});
els.secondaryEditorText.addEventListener("keydown", handleSecondaryKeydown);
els.editPathBtn.onclick = () => togglePathEditor("primary");
els.secondaryEditPathBtn.onclick = () => togglePathEditor("secondary");
els.pathInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); updatePrimaryPathUI(els.pathInput.value.trim()); togglePathEditor("primary"); } });
els.secondaryPathInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); updateSecondaryPathUI(els.secondaryPathInput.value.trim()); togglePathEditor("secondary"); } });

const setActivePane = pane => { state.activePane = pane; els.primaryPane.classList.toggle("pane-active", pane === "primary"); els.secondaryPane.classList.toggle("pane-active", pane === "secondary"); };
els.primaryPane.addEventListener("pointerdown", () => setActivePane("primary"));
els.secondaryPane.addEventListener("pointerdown", () => setActivePane("secondary"));

els.paneSplitter.addEventListener("pointerdown", e => {
  if (!els.paneHost.classList.contains("split-active")) return;
  e.preventDefault();
  els.paneSplitter.setPointerCapture?.(e.pointerId);
  const hostRect = els.paneHost.getBoundingClientRect();
  const vertical = state.splitOrientation === "vertical";
  const onMove = ev => {
    const raw = vertical ? (ev.clientX - hostRect.left) / hostRect.width : (ev.clientY - hostRect.top) / hostRect.height;
    const ratio = Math.max(.2, Math.min(.8, raw));
    els.primaryPane.style.flexBasis = `${ratio * 100}%`;
    els.secondaryPane.style.flexBasis = `${(1 - ratio) * 100}%`;
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
});

function restorePanelWidths() {
  const left = Number(localStorage.getItem("pv_sidebar_width"));
  const right = Number(localStorage.getItem("pv_context_width"));
  if (Number.isFinite(left) && left >= 180 && left <= 520) document.documentElement.style.setProperty("--sidebar", `${left}px`);
  if (Number.isFinite(right) && right >= 200 && right <= 520) document.documentElement.style.setProperty("--context", `${right}px`);
}

function setupSidebarResizer(handle, side) {
  if (!handle) return;
  handle.addEventListener("pointerdown", e => {
    if (window.matchMedia("(max-width: 980px)").matches) return;
    e.preventDefault(); handle.classList.add("dragging"); handle.setPointerCapture?.(e.pointerId);
    const appRect = els.appView.getBoundingClientRect();
    const ribbon = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ribbon")) || 44;
    const move = ev => {
      const width = side === "left" ? ev.clientX - appRect.left - ribbon : appRect.right - ev.clientX;
      const clamped = Math.max(side === "left" ? 180 : 200, Math.min(520, width));
      document.documentElement.style.setProperty(side === "left" ? "--sidebar" : "--context", `${clamped}px`);
    };
    const up = ev => {
      handle.classList.remove("dragging"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(side === "left" ? "--sidebar" : "--context"));
      localStorage.setItem(side === "left" ? "pv_sidebar_width" : "pv_context_width", String(value));
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
  });
  handle.addEventListener("dblclick", () => {
    const value = side === "left" ? 270 : 285;
    document.documentElement.style.setProperty(side === "left" ? "--sidebar" : "--context", `${value}px`);
    localStorage.removeItem(side === "left" ? "pv_sidebar_width" : "pv_context_width");
  });
}
restorePanelWidths(); setupSidebarResizer(els.leftSidebarResizer, "left"); setupSidebarResizer(els.rightSidebarResizer, "right");

els.fileList.addEventListener("dragover", e => {
  if (e.target === els.fileList && Array.from(e.dataTransfer.types || []).includes("text/private-vault-note")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; els.fileList.classList.add("drop-root"); }
});
els.fileList.addEventListener("dragleave", e => { if (e.target === els.fileList) els.fileList.classList.remove("drop-root"); });
els.fileList.addEventListener("drop", e => {
  if (e.target !== els.fileList) return;
  e.preventDefault(); els.fileList.classList.remove("drop-root");
  const path = e.dataTransfer.getData("text/private-vault-note") || e.dataTransfer.getData("text/plain");
  if (path) moveNoteToFolder(path, "");
});

els.fileList.addEventListener("contextmenu", e => {
  if (e.target !== els.fileList) return;
  e.preventDefault(); state.selectedFolder = "";
  showFloatingMenu([
    { label: "Новая заметка", shortcut: "Ctrl+N", action: () => newNote() },
    { label: "Новая папка", shortcut: "Ctrl+Shift+N", action: () => createFolder("") },
  ], e.clientX, e.clientY);
});

els.editorText.addEventListener("input", () => {
  if (state.editorMode !== "raw") return;
  syncActiveTabText(els.editorText.value);
  updateWikiSuggestions();
  scheduleDerivedDocumentUI(els.editorText.value);
});
els.editorText.addEventListener("keydown", handleEditorKeydown);
els.editorText.addEventListener("click", scheduleWikiSuggestions);
els.editorText.addEventListener("blur", () => setTimeout(() => hideWikiSuggestions(), 150));

document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeFloatingMenu();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyN") { e.preventDefault(); newNote(); return; }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && e.code === "KeyN") { e.preventDefault(); createFolder(); return; }
  // One-time Obsidian vault import. Intentionally hidden from the permanent UI.
  if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyI") {
    e.preventDefault();
    if (!els.appView.classList.contains("hidden")) {
      showToast("Импорт Obsidian: выбери папку vault.");
      els.vaultImport.click();
    }
  }
});

window.addEventListener("resize", () => {
  if (!window.matchMedia("(max-width: 980px)").matches) {
    els.sidebar.classList.remove("open");
    els.contextSidebar.classList.remove("open");
  }
});

(function restoreSession() {
  const owner = sessionStorage.getItem("pv_owner");
  const repo = sessionStorage.getItem("pv_repo");
  const token = sessionStorage.getItem("pv_token");
  if (owner && repo && token) {
    els.ownerInput.value = owner;
    els.repoInput.value = repo;
    els.tokenInput.value = token;
    connect();
  }
})();

console.info("note v1.2 ready");
