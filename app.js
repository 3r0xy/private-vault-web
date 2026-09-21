import { EditorView, Decoration, WidgetType, ViewPlugin, keymap, drawSelection, highlightActiveLine } from "https://esm.sh/@codemirror/view@6.43.12?deps=@codemirror/state@6.7.5";
import { history, historyKeymap, defaultKeymap, undo, redo } from "https://esm.sh/@codemirror/commands@6.11.1?deps=@codemirror/state@6.7.5,@codemirror/view@6.43.12";
import { markdown, markdownKeymap } from "https://esm.sh/@codemirror/lang-markdown@6.5.2?deps=@codemirror/state@6.7.5,@codemirror/view@6.43.12";

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
  graph: { nodes: [], links: [], simulation: null, zoom: null, svg: null },
  editorMode: "live",
  editorView: null,
  syncingEditor: false,
  expandedFolders: new Set(),
  splitOrientation: "vertical",
  secondary: { path: null, sha: null, mode: "live", editorView: null, syncing: false },
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
  activeNoteTitle: $("activeNoteTitle"), searchRibbonBtn: $("searchRibbonBtn"), rightPanelBtn: $("rightPanelBtn"),
  contextSidebar: $("contextSidebar"), branchStatus: $("branchStatus"), syncStatus: $("syncStatus"),
  statusWords: $("statusWords"), statusChars: $("statusChars"),
  paneHost: $("paneHost"), primaryPane: $("primaryPane"), secondaryPane: $("secondaryPane"), paneSplitter: $("paneSplitter"), splitBtn: $("splitBtn"),
  secondaryNoteTitle: $("secondaryNoteTitle"), secondaryPathInput: $("secondaryPathInput"), secondaryLiveEditorHost: $("secondaryLiveEditorHost"),
  secondaryEditorText: $("secondaryEditorText"), secondaryPreviewBtn: $("secondaryPreviewBtn"), secondaryEditBtn: $("secondaryEditBtn"),
  secondarySaveBtn: $("secondarySaveBtn"), secondaryCloseBtn: $("secondaryCloseBtn"), secondaryFormatToolbar: $("secondaryFormatToolbar"),
};

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

function updateDocumentStatus(text = "") {
  const plain = String(text).replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`~\[\]()!-]/g, " ");
  const words = (plain.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu) || []).length;
  els.statusWords.textContent = `Слов: ${words}`;
  els.statusChars.textContent = `Символов: ${String(text).length}`;
}

function updateActiveNoteTitle(path = null) {
  els.activeNoteTitle.textContent = path ? noteName(path) : "Новая вкладка";
}

function closeFloatingMenu() {
  document.querySelectorAll(".floating-menu").forEach(el => el.remove());
}

function showFloatingMenu(items, x, y) {
  closeFloatingMenu();
  const menu = document.createElement("div");
  menu.className = "floating-menu";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = item.label;
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

function attachFileOpenHandlers(button, path) {
  button.onclick = () => openNote(path);
  button.oncontextmenu = e => {
    e.preventDefault();
    showFloatingMenu([
      { label: "Открыть", action: () => openNote(path) },
      { label: "Открыть справа", action: () => openInSplit(path, "vertical") },
      { label: "Открыть снизу", action: () => openInSplit(path, "horizontal") },
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

    els.vaultTitle.textContent = state.repo;
    els.branchStatus.textContent = state.branch;
    await loadTree();

    els.loginView.classList.add("hidden");
    els.appView.classList.remove("hidden");
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
  const root = { folders: new Map(), files: [] };
  for (const note of notes.slice().sort((a, b) => a.path.localeCompare(b.path, "ru"))) {
    const parts = note.path.split("/");
    const filename = parts.pop();
    let node = root;
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [], path: currentPath });
      node = node.folders.get(part);
    }
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
      btn.innerHTML = `<span class="file-icon">◇</span><span class="file-name">${escapeHtml(noteName(note.path))}</span>${folder ? `<span class="search-path">${escapeHtml(folder)}</span>` : ""}`;
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
      row.className = `folder-row ${open ? "open" : ""}`;
      row.style.paddingLeft = `${6 + level * 13}px`;
      row.innerHTML = `<span class="folder-chevron">›</span><span class="folder-name">${escapeHtml(name)}</span>`;
      const children = document.createElement("div");
      children.className = `folder-children ${open ? "open" : ""}`;
      row.onclick = () => {
        if (state.expandedFolders.has(folder.path)) state.expandedFolders.delete(folder.path);
        else state.expandedFolders.add(folder.path);
        row.classList.toggle("open");
        children.classList.toggle("open");
      };
      container.appendChild(row);
      container.appendChild(children);
      renderNode(folder, children, level + 1);
    }

    for (const note of node.files.sort((a,b) => a.filename.localeCompare(b.filename, "ru"))) {
      const btn = document.createElement("button");
      btn.className = `file-item ${state.current === note.path ? "active" : ""}`;
      btn.style.paddingLeft = `${18 + level * 13}px`;
      btn.innerHTML = `<span class="file-icon">◇</span><span class="file-name">${escapeHtml(noteName(note.path))}</span>`;
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
    const item = await getFile(path);
    state.current = path;
    state.currentSha = item.sha;
    els.pathInput.value = path;
    updateActiveNoteTitle(path);
    setEditorMarkdown(item.text);
    els.emptyState.classList.add("hidden");
    els.editorView.classList.remove("hidden");
    showPreview();
    renderFileList(els.searchInput.value);
    await Promise.all([renderBacklinks(path), renderOutgoing(item.text)]);
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
  toDOM() {
    const span = document.createElement("span");
    const label = this.raw.includes("|") ? this.raw.split("|").slice(1).join("|") : this.raw.split("#")[0];
    span.className = `cm-wiki-chip ${this.resolved ? "" : "missing"}`;
    span.textContent = label || this.raw;
    span.title = this.resolved ? `Открыть [[${this.raw}]]` : `Создать [[${normalizeWikiTarget(this.raw)}]]`;
    span.addEventListener("mousedown", e => e.preventDefault());
    span.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (this.resolved) openNote(this.resolved);
      else createFromMissingLink(this.raw);
    });
    return span;
  }
  ignoreEvent() { return false; }
}

function selectionTouches(view, from, to) {
  const sel = view.state.selection.main;
  return sel.from <= to && sel.to >= from;
}

function buildLiveDecorations(view) {
  const ranges = [];
  const seenLines = new Set();
  const doc = view.state.doc;

  for (const vr of view.visibleRanges) {
    let pos = vr.from;
    while (pos <= vr.to && pos <= doc.length) {
      const line = doc.lineAt(pos);
      if (!seenLines.has(line.number)) {
        seenLines.add(line.number);
        const text = line.text;
        const base = line.from;
        const activeLine = selectionTouches(view, line.from, line.to);
        const wikiSpans = [];

        // Obsidian-style wiki links. When the cursor is inside a link, raw syntax is shown.
        const wikiRe = /\[\[([^\]]+)\]\]/g;
        let wm;
        while ((wm = wikiRe.exec(text)) !== null) {
          const from = base + wm.index;
          const to = from + wm[0].length;
          wikiSpans.push([from, to]);
          const resolved = wikiTargetToPath(wm[1]);
          if (selectionTouches(view, from, to)) {
            ranges.push(Decoration.mark({ class: `cm-live-wiki-raw ${resolved ? "" : "missing"}` }).range(from, to));
          } else {
            ranges.push(Decoration.replace({ widget: new WikiLinkWidget(wm[1], resolved), inclusive: false }).range(from, to));
          }
        }

        const overlapsWiki = (from, to) => wikiSpans.some(([a, b]) => from < b && to > a);

        // Headings: hide Markdown # markers and style the text like a heading.
        const hm = text.match(/^(#{1,6})\s+/);
        if (hm) {
          const markerTo = base + hm[0].length;
          const level = hm[1].length;
          ranges.push(Decoration.line({ class: `cm-live-heading-line cm-live-heading-${level}` }).range(base));
          if (!selectionTouches(view, base, markerTo)) {
            ranges.push(Decoration.replace({}).range(base, markerTo));
          } else {
            ranges.push(Decoration.mark({ class: "cm-md-marker" }).range(base, markerTo));
          }
          if (markerTo < line.to) ranges.push(Decoration.mark({ class: `cm-live-heading-text cm-live-h${level}` }).range(markerTo, line.to));
        }

        // Blockquotes get a visual rail; hide the > marker outside the active marker.
        const qm = text.match(/^(\s*)>\s?/);
        if (qm) {
          const markerFrom = base + qm[1].length;
          const markerTo = base + qm[0].length;
          ranges.push(Decoration.line({ class: "cm-live-blockquote" }).range(base));
          if (!selectionTouches(view, markerFrom, markerTo)) ranges.push(Decoration.replace({}).range(markerFrom, markerTo));
        }

        // Strong text.
        const boldRe = /(\*\*|__)([^\n]+?)\1/g;
        let bm;
        while ((bm = boldRe.exec(text)) !== null) {
          const from = base + bm.index;
          const openTo = from + bm[1].length;
          const innerTo = openTo + bm[2].length;
          const to = innerTo + bm[1].length;
          if (overlapsWiki(from, to)) continue;
          ranges.push(Decoration.mark({ class: "cm-live-bold" }).range(openTo, innerTo));
          if (!selectionTouches(view, from, to)) {
            ranges.push(Decoration.replace({}).range(from, openTo));
            ranges.push(Decoration.replace({}).range(innerTo, to));
          } else {
            ranges.push(Decoration.mark({ class: "cm-md-marker" }).range(from, openTo));
            ranges.push(Decoration.mark({ class: "cm-md-marker" }).range(innerTo, to));
          }
        }

        // Italic text. Skip ** / __ pairs already handled above.
        const italicRe = /(\*|_)([^\n]+?)\1/g;
        let im;
        while ((im = italicRe.exec(text)) !== null) {
          const from = base + im.index;
          const to = from + im[0].length;
          const prev = text[im.index - 1] || "";
          const next = text[im.index + im[0].length] || "";
          if (prev === im[1] || next === im[1] || overlapsWiki(from, to)) continue;
          const innerFrom = from + 1;
          const innerTo = to - 1;
          ranges.push(Decoration.mark({ class: "cm-live-italic" }).range(innerFrom, innerTo));
          if (!selectionTouches(view, from, to)) {
            ranges.push(Decoration.replace({}).range(from, innerFrom));
            ranges.push(Decoration.replace({}).range(innerTo, to));
          }
        }

        // Strikethrough and inline code.
        for (const [re, cls, marker] of [
          [/~~([^\n]+?)~~/g, "cm-live-strike", 2],
          [/`([^`\n]+?)`/g, "cm-live-code", 1],
        ]) {
          let m;
          while ((m = re.exec(text)) !== null) {
            const from = base + m.index;
            const to = from + m[0].length;
            if (overlapsWiki(from, to)) continue;
            const innerFrom = from + marker;
            const innerTo = to - marker;
            ranges.push(Decoration.mark({ class: cls }).range(innerFrom, innerTo));
            if (!selectionTouches(view, from, to)) {
              ranges.push(Decoration.replace({}).range(from, innerFrom));
              ranges.push(Decoration.replace({}).range(innerTo, to));
            }
          }
        }

        // Regular Markdown links: visually emphasize label and collapse destination while inactive.
        const linkRe = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
        let lm;
        while ((lm = linkRe.exec(text)) !== null) {
          const from = base + lm.index;
          const labelFrom = from + 1;
          const labelTo = labelFrom + lm[1].length;
          const to = from + lm[0].length;
          if (overlapsWiki(from, to)) continue;
          ranges.push(Decoration.mark({ class: "cm-live-link" }).range(labelFrom, labelTo));
          if (!selectionTouches(view, from, to)) {
            ranges.push(Decoration.replace({}).range(from, labelFrom));
            ranges.push(Decoration.replace({}).range(labelTo, to));
          }
        }

        // Checkboxes and lists retain their source but get softer structural styling.
        if (/^\s*-\s+\[[ xX]\]\s+/.test(text)) ranges.push(Decoration.line({ class: "cm-live-task-line" }).range(base));
        else if (/^\s*[-*+]\s+/.test(text) || /^\s*\d+[.)]\s+/.test(text)) ranges.push(Decoration.line({ class: "cm-live-list-line" }).range(base));
      }
      if (line.to >= doc.length || line.to >= vr.to) break;
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

const livePreviewDecorations = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildLiveDecorations(view); }
  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = buildLiveDecorations(update.view);
  }
}, { decorations: v => v.decorations });

function initLiveEditor() {
  if (state.editorView) return state.editorView;
  state.editorView = new EditorView({
    doc: "",
    parent: els.liveEditorHost,
    extensions: [
      history(),
      drawSelection(),
      highlightActiveLine(),
      markdown(),
      EditorView.lineWrapping,
      livePreviewDecorations,
      keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => {
        if (state.syncingEditor) return;
        if (update.docChanged) {
          const value = update.state.doc.toString();
          els.editorText.value = value;
          renderOutgoing(value);
          updateDocumentStatus(value);
        }
        if (update.docChanged || update.selectionSet || update.viewportChanged) updateWikiSuggestions();
      }),
      EditorView.domEventHandlers({
        keydown(event) { return handleEditorKeydown(event); },
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
      history(), drawSelection(), highlightActiveLine(), markdown(), EditorView.lineWrapping,
      livePreviewDecorations,
      keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => {
        if (state.secondary.syncing) return;
        if (update.docChanged) els.secondaryEditorText.value = update.state.doc.toString();
      }),
      EditorView.domEventHandlers({
        keydown(event) { return handleSecondaryKeydown(event); },
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

async function openInSplit(path, orientation = "vertical") {
  setMode("notes");
  try {
    const item = await getFile(path);
    state.secondary.path = path;
    state.secondary.sha = item.sha;
    els.secondaryPathInput.value = path;
    els.secondaryNoteTitle.textContent = noteName(path);
    setSecondaryMarkdown(item.text);
    setSplitOrientation(orientation);
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

function secondaryPrefixLines(prefixer) {
  const sel = secondarySelection();
  const text = sel.text;
  const lineStart = text.lastIndexOf("\n", Math.max(0, sel.start - 1)) + 1;
  let lineEnd = text.indexOf("\n", sel.end);
  if (lineEnd === -1) lineEnd = text.length;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n").map((line, i) => `${prefixer(i)}${line}`).join("\n");
  replaceSecondaryRange(lineStart, lineEnd, lines, lineStart + lines.length, lineStart, lineStart + lines.length);
}

function secondaryToolbarAction(action) {
  if (action === "undo") { if (state.secondary.mode === "live" && state.secondary.editorView) return undo(state.secondary.editorView); document.execCommand("undo"); return; }
  if (action === "redo") { if (state.secondary.mode === "live" && state.secondary.editorView) return redo(state.secondary.editorView); document.execCommand("redo"); return; }
  if (action === "bold") return secondaryReplaceSelection("**", "**", "жирный текст");
  if (action === "italic") return secondaryReplaceSelection("*", "*", "курсив");
  if (action === "wiki") { const sel = secondarySelection(); replaceSecondaryRange(sel.start, sel.end, "[[]]", sel.start + 2); return; }
  if (action === "h1") return secondaryPrefixLines(() => "# ");
  if (action === "h2") return secondaryPrefixLines(() => "## ");
  if (action === "bullet") return secondaryPrefixLines(() => "- ");
  if (action === "numbered") return secondaryPrefixLines(i => `${i + 1}. `);
  if (action === "todo") return secondaryPrefixLines(() => "- [ ] ");
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
  els.editorText.value = text;
  setLiveEditorDoc(text, 0);
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
  try {
    setSyncStatus("Сохранение…");
    const saved = await persistMarkdownFile({
      path: els.pathInput.value.trim(), oldPath: state.current, currentSha: state.currentSha, markdownText,
    });
    state.current = saved.path;
    state.currentSha = saved.sha;
    els.pathInput.value = saved.path;
    updateActiveNoteTitle(saved.path);
    state.contents.set(saved.path, { text: markdownText, sha: saved.sha });
    await loadTree();
    state.contents.set(saved.path, { text: markdownText, sha: saved.sha });
    await Promise.all([renderBacklinks(saved.path), renderOutgoing(markdownText)]);
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
    els.secondaryPathInput.value = saved.path;
    els.secondaryNoteTitle.textContent = noteName(saved.path);
    state.contents.set(saved.path, { text: markdownText, sha: saved.sha });
    await loadTree();
    state.contents.set(saved.path, { text: markdownText, sha: saved.sha });
    setSyncStatus("Сохранено");
    showToast("Вторая область сохранена в GitHub.");
  } catch (e) {
    setSyncStatus("Ошибка сохранения");
    showToast(`Не сохранено: ${e.message}`);
  }
}

function newNote(path = `notes/Новая заметка ${new Date().toISOString().slice(0,10)}.md`) {
  state.current = null;
  state.currentSha = null;
  els.pathInput.value = path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
  updateActiveNoteTitle(els.pathInput.value);
  setEditorMarkdown(`# ${noteName(els.pathInput.value)}\n\n`);
  els.emptyState.classList.add("hidden");
  els.editorView.classList.remove("hidden");
  els.backlinksList.textContent = "—";
  els.outgoingList.textContent = "—";
  setMode("notes");
  showPreview();
  els.sidebar.classList.remove("open");
  setSyncStatus("Новая заметка");
  setTimeout(() => state.editorView?.focus(), 0);
}

function createFromMissingLink(target) {
  const clean = normalizeWikiTarget(target);
  if (!clean) return;
  const path = clean.includes("/") ? `${clean}.md` : `notes/${clean}.md`;
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

function prefixSelectedLines(prefixer) {
  const sel = currentSelection();
  const text = sel.text;
  const lineStart = text.lastIndexOf("\n", Math.max(0, sel.start - 1)) + 1;
  let lineEnd = text.indexOf("\n", sel.end);
  if (lineEnd === -1) lineEnd = text.length;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n").map((line, i) => `${prefixer(i)}${line}`).join("\n");
  replaceEditorRange(lineStart, lineEnd, lines, lineStart + lines.length, lineStart, lineStart + lines.length);
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
  if (action === "wiki") { insertAtCursor("[[]]", 2); updateWikiSuggestions(); return; }
  if (action === "link") return replaceSelection("[", "](https://)", "текст ссылки");
  if (action === "image") return insertAtCursor("![описание](путь-к-изображению)");
  if (action === "code") return replaceSelection("`", "`", "код");
  if (action === "h1") return prefixSelectedLines(() => "# ");
  if (action === "h2") return prefixSelectedLines(() => "## ");
  if (action === "bullet") return prefixSelectedLines(() => "- ");
  if (action === "numbered") return prefixSelectedLines(i => `${i + 1}. `);
  if (action === "todo") return prefixSelectedLines(() => "- [ ] ");
  if (action === "quote") return prefixSelectedLines(() => "> ");
}

function activeWikiQuery() {
  const sel = currentSelection();
  const cursor = sel.cursor;
  if (sel.start !== sel.end) return null;
  const before = sel.text.slice(0, cursor);
  const open = before.lastIndexOf("[[");
  if (open === -1) return null;
  const close = before.lastIndexOf("]]" );
  if (close > open) return null;
  const query = before.slice(open + 2);
  if (query.includes("\n") || query.length > 100) return null;
  return { query, start: open, end: cursor };
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
  }
}

async function buildGraph(forceReload = false) {
  if (!window.d3) return showToast("D3 не загрузился — проверь интернет-соединение.");
  els.graphLoading.classList.remove("hidden");
  try {
    const existingIds = new Set(state.notes.map(n => n.path.replace(/\.md$/i, "")));
    const nameToId = new Map(state.notes.map(n => [noteName(n.path).toLowerCase(), n.path.replace(/\.md$/i, "")]));
    const nodesMap = new Map();
    const links = [];

    for (const note of state.notes) {
      const id = note.path.replace(/\.md$/i, "");
      nodesMap.set(id, { id, path: note.path, label: noteName(note.path), missing: false, degree: 0 });
    }

    for (const note of state.notes) {
      const source = note.path.replace(/\.md$/i, "");
      let item;
      try {
        item = forceReload ? await fetchFileFresh(note.path) : await getFile(note.path);
      } catch {
        continue;
      }
      const seenTargets = new Set();
      for (const link of extractWikiLinks(item.text)) {
        const candidate = link.target;
        const resolved = existingIds.has(candidate) ? candidate : nameToId.get(candidate.toLowerCase());
        const target = resolved || candidate;
        if (!target || seenTargets.has(target)) continue;
        seenTargets.add(target);
        if (!nodesMap.has(target)) nodesMap.set(target, { id: target, path: null, label: target.split("/").pop(), missing: true, degree: 0 });
        links.push({ source, target });
      }
    }

    for (const link of links) {
      nodesMap.get(link.source).degree++;
      nodesMap.get(link.target).degree++;
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

async function fetchFileFresh(path) {
  const data = await gh(`/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(state.branch)}`);
  const item = { text: base64ToUtf8(data.content || ""), sha: data.sha };
  state.contents.set(path, item);
  return item;
}

function renderGraph(nodes, links) {
  const svg = d3.select(els.graphSvg);
  svg.selectAll("*").remove();
  if (state.graph.simulation) state.graph.simulation.stop();

  const rect = els.graphSvg.getBoundingClientRect();
  const width = Math.max(320, rect.width || 900);
  const height = Math.max(320, rect.height || 650);
  svg.attr("viewBox", [0, 0, width, height]);

  const root = svg.append("g");
  const link = root.append("g")
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("class", "graph-link")
    .attr("stroke-width", d => 1 + Math.min(1.5, ((d.source.degree || 0) + (d.target.degree || 0)) / 20));

  const node = root.append("g")
    .selectAll("g")
    .data(nodes, d => d.id)
    .join("g")
    .attr("class", d => `graph-node ${d.missing ? "missing" : ""}`)
    .style("cursor", d => d.missing ? "default" : "pointer");

  node.append("circle")
    .attr("r", d => 5 + Math.min(8, Math.sqrt(d.degree || 0) * 2));

  node.append("text")
    .attr("x", d => 9 + Math.min(8, Math.sqrt(d.degree || 0) * 2))
    .attr("y", 4)
    .text(d => d.label);

  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(d => 70 + Math.min(80, ((d.source.degree || 0) + (d.target.degree || 0)) * 4)).strength(.65))
    .force("charge", d3.forceManyBody().strength(d => -90 - Math.min(220, (d.degree || 0) * 14)))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius(d => 25 + Math.min(20, (d.degree || 0) * 2)))
    .on("tick", () => {
      link
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

  const drag = d3.drag()
    .on("start", (event, d) => {
      if (!event.active) simulation.alphaTarget(.25).restart();
      d.fx = d.x; d.fy = d.y;
    })
    .on("drag", (event, d) => {
      d.fx = event.x; d.fy = event.y;
    })
    .on("end", (event, d) => {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null; d.fy = null;
    });
  node.call(drag);

  node.on("click", (event, d) => {
    event.stopPropagation();
    if (d.path) openNote(d.path);
  });

  const zoom = d3.zoom()
    .scaleExtent([0.12, 5])
    .on("zoom", event => root.attr("transform", event.transform));
  svg.call(zoom);

  state.graph.simulation = simulation;
  state.graph.zoom = zoom;
  state.graph.svg = svg;
  state.graph.root = root;
  state.graph.nodeSelection = node;
  state.graph.linkSelection = link;
  setTimeout(() => fitGraph(false), 500);
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
els.logoutBtn.onclick = logout;
els.vaultImport.onchange = e => importVault(e.target.files);
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
els.editorText.addEventListener("input", () => {
  if (state.editorMode !== "raw") return;
  updateWikiSuggestions();
  renderOutgoing(els.editorText.value);
  updateDocumentStatus(els.editorText.value);
});
els.editorText.addEventListener("keydown", handleEditorKeydown);
els.editorText.addEventListener("click", updateWikiSuggestions);
els.editorText.addEventListener("blur", () => setTimeout(() => hideWikiSuggestions(), 150));

document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeFloatingMenu();
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
