// Pure helpers shared by the app and regression tests.
export function cleanPath(value) {
  const parts = [];
  for (const part of value.normalize('NFC').replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return parts.join('/');
}

export function resolveNote(target, source, notes, relative = false) {
  let value = String(target).split('|')[0].split('#')[0].trim();
  try { value = decodeURIComponent(value); } catch {}
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null;
  const key = p => cleanPath(p).replace(/\.md$/i, '').toLocaleLowerCase('ru');
  const folder = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : '';
  const candidates = value.startsWith('/') ? [key(value)] : relative || value.startsWith('.')
    ? [key(`${folder}/${value}`), key(value)] : [key(value), key(`${folder}/${value}`)];
  for (const candidate of candidates) {
    const match = notes.find(n => key(n.path) === candidate);
    if (match) return match.path;
  }
  if (!relative && !value.includes('/')) {
    const matches = notes.filter(n => key(n.path.split('/').pop()) === key(value));
    if (matches.length === 1) return matches[0].path;
  }
  return null;
}

export function noteLinks(text) {
  // Ignore fenced code and inline code, where links are only examples.
  const source = String(text).replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm, '').replace(/`+[^`\n]*`+/g, '');
  const links = [];
  for (const m of source.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
    if (m[1] && /\.(png|jpe?g|gif|webp|svg|pdf|mp[34])(?:[|#]|$)/i.test(m[2])) continue;
    links.push({ target: m[2], relative: false });
  }
  for (const m of source.matchAll(/(?<!!)\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g)) {
    const target = m[1].replace(/^<|>$/g, '');
    if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target) && target.split('#')[0]) links.push({ target, relative: true });
  }
  return links;
}

export function folderMoveEntries(files, oldFolder, newFolder) {
  oldFolder = cleanPath(oldFolder); newFolder = cleanPath(newFolder);
  if (!oldFolder || !newFolder || oldFolder === newFolder) return [];
  if (newFolder.startsWith(oldFolder + '/')) throw new Error('Нельзя переместить папку внутрь самой себя.');
  const inside = f => f.path.startsWith(oldFolder + '/');
  const items = files.filter(inside);
  if (!items.length) throw new Error('Папка не найдена.');
  if (files.some(f => !inside(f) && (f.path === newFolder || f.path.startsWith(newFolder + '/')))) throw new Error('Папка назначения уже существует. Выбери другое имя.');
  return items.flatMap(f => [
    { path: newFolder + f.path.slice(oldFolder.length), mode: f.mode || '100644', type: 'blob', sha: f.sha },
    { path: f.path, mode: f.mode || '100644', type: 'blob', sha: null },
  ]);
}

export function mergeWeekTasks(existing, additions) {
  const tasks = existing.map(t => ({ ...t }));
  const identity = t => t.originKey || (t.recurrenceId ? `repeat:${t.recurrenceId}:${t.day}` : `id:${t.id}`);
  const seen = new Set(tasks.map(identity));
  for (const task of additions) {
    const key = identity(task);
    if (!seen.has(key)) { tasks.push({ ...task }); seen.add(key); }
  }
  return tasks;
}

export function rewriteFolderLinks(text, source, notes, oldFolder, newFolder) {
  const move = path => path.startsWith(oldFolder + '/') ? newFolder + path.slice(oldFolder.length) : path;
  const relativePath = (from, to) => {
    const a = from.split('/'); a.pop(); const b = to.split('/');
    while (a.length && b.length && a[0] === b[0]) {a.shift();b.shift();}
    return [...a.map(()=>'..'),...b].join('/');
  };
  return String(text).split(/(^[ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[^\n]*$|`+[^`\n]*`+)/gm).map((part,i) => {
    if (i % 2) return part;
    return part.replace(/\[\[([^\]]+)\]\]/g,(full,raw)=>{
      const target=resolveNote(raw,source,notes);
      const base=raw.split('|')[0].split('#')[0];
      if (!target || move(target)===target || !base.includes('/')) return full;
      const extension=/\.md$/i.test(base) ? '.md' : '';
      return `[[${move(target).replace(/\.md$/i,'')}${extension}${raw.slice(base.length)}]]`;
    }).replace(/(?<!!)\[([^\]\n]*)\]\(\s*(<[^>]+>|[^\s)]+)(\s+[^)]*)?\)/g,(full,label,raw,title='')=>{
      const original=raw.replace(/^<|>$/g,'');
      const target=resolveNote(original,source,notes,true);
      if (!target || move(source)===source && move(target)===target) return full;
      const hash=original.includes('#') ? original.slice(original.indexOf('#')) : '';
      const next=original.startsWith('/') ? '/' + move(target) : relativePath(move(source),move(target));
      return `[${label}](${encodeURI(next).replace(/#/g,'%23')}${hash}${title})`;
    });
  }).join('');
}

export function addDays(ymd, days) {
  const [y,m,d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y,m-1,d + days));
  return date.toISOString().slice(0,10);
}
export function weekStart(ymd) {
  const day = new Date(ymd + 'T12:00:00Z').getUTCDay();
  return addDays(ymd, -((day + 6) % 7));
}
export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && addDays(value, 0) === value;
}

export function preparationTasks(event, steps, days, hours, id) {
  if (!validDate(event.date) || !Number.isInteger(days) || days < 1 || !Number.isFinite(hours) || hours <= 0) throw new Error('Укажи дату, дни и часы подготовки.');
  const labels = steps.map(s => s.trim()).filter(Boolean);
  if (!labels.length) throw new Error('Добавь хотя бы один шаг подготовки.');
  return labels.map((text, i) => ({
    id: id(), text, projectId: event.projectId, eventId: event.id,
    date: addDays(event.date, -days + Math.floor(i * days / labels.length)),
    duration: Math.round(hours * 60 / labels.length), repeat: 'none', done: false, section: 'general',
  }));
}
