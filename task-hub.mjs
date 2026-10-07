import { addDays, weekStart, validDate, preparationTasks, mergeWeekTasks } from './domain.mjs';

const PATH = 'planner/projects.md';
const STATE = /<!-- NOTE_PROJECTS_STATE:([A-Za-z0-9+/=]+) -->/;
const DEFAULT_PROJECTS = [
  {id:'media',name:'Медиакружок'}, {id:'vkr',name:'ВКР'}, {id:'sfu',name:'СФУ'},
];
const encode = text => {
  const bytes = new TextEncoder().encode(text);
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
};
const decode = text => new TextDecoder().decode(Uint8Array.from(atob(text), c => c.charCodeAt(0)));
const dateLabel = value => value ? new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'}).format(new Date(value+'T12:00:00')) : 'Без даты';

export function hubTasksForWeek(tasks, start, id) {
  const result = [];
  for (const task of tasks) {
    if (task.done || !validDate(task.date)) continue;
    for (let day = 0; day < 7; day++) {
      const date = addDays(start, day);
      if (date < task.date) continue;
      const matches = task.repeat === 'daily' || (task.repeat === 'weekly' && weekStart(date) >= weekStart(task.date) && new Date(date+'T12:00:00Z').getUTCDay() === new Date(task.date+'T12:00:00Z').getUTCDay()) || date === task.date;
      if (!matches) continue;
      result.push({id:id(),originKey:`hub:${task.id}:${date}`,hubTaskId:task.id,hubRevision:task.updatedAt || '',projectId:task.projectId || '',day,section:task.section || 'general',text:task.text,time:task.time || '',duration:task.duration || 0,repeat:'none',done:false,order:Date.now()+result.length});
    }
  }
  return result;
}

export function createTaskHub(ctx) {
  const {state,$,showToast,escapeHtml:h,plannerFetchFile:fetchFile,plannerRegisterFile:register,plannerParse,plannerSerialize,plannerEmptyData,plannerTaskId:id,plannerFlush,commitVaultEntries,plannerRender} = ctx;
  let data = null, sha = null, account = '', filter = 'all', editing = null, busy = false, loading = null;
  const controller = {open,load,ensureWeek,tasksForWeek,populateProjects,invalidate:()=>{data=null;},projectName:projectId=>data?.projects.find(p=>p.id===projectId)?.name || '',get busy(){return busy;}};
  function fresh() { return {version:1,projects:DEFAULT_PROJECTS.map(p=>({...p})),tasks:[]}; }
  async function load(force = false) {
    const key = `${state.owner}/${state.repo}`;
    if (data && account === key && !force) return;
    if (loading) return loading;
    loading = (async () => {
      const file = await fetchFile(PATH);
      if (file) {
        const match = file.text.match(STATE);
        if (!match) throw new Error('Не удалось прочитать файл проектов. Его содержимое сохранено; проверь planner/projects.md.');
        let parsed;
        try { parsed = JSON.parse(decode(match[1])); } catch { throw new Error('Данные проектов повреждены. Файл не будет перезаписан.'); }
        if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.projects)) throw new Error('Неверный формат файла проектов.');
        data = parsed; sha = file.sha;
      } else { data = fresh(); sha = null; }
      account = key;
    })();
    try { await loading; } finally { loading = null; }
  }
  function serialize(value) {
    const lines = ['# Будущие дела и проекты','','События, подготовка и постоянные задачи.',''];
    for (const project of [{id:'',name:'Без проекта'},...value.projects]) {
      lines.push(`## ${project.name}`,'');
      for (const task of value.tasks.filter(t => (t.projectId || '') === project.id)) {
        lines.push(`- [${task.done?'x':' '}] ${task.text}${task.date?` · ${task.date}`:''}${task.repeat && task.repeat!=='none'?` · ${task.repeat==='daily'?'каждый день':'каждую неделю'}`:''}`);
        if (task.kind === 'event') lines.push(`  - Подготовка: ${task.prepDays && task.prepHours?`${task.prepDays} дней, ${task.prepHours} ч`:'уточнить срок и время'}`);
      }
      lines.push('');
    }
    lines.push(`<!-- NOTE_PROJECTS_STATE:${encode(JSON.stringify(value))} -->`,'');
    return lines.join('\n');
  }
  function tasksForWeek(start) { return hubTasksForWeek(data?.tasks || [],start,id); }
  async function ensureWeek(start, weekData, weekSha) {
    await load();
    if (weekData.closedAt) return {data:weekData,sha:weekSha};
    const merged = mergeWeekTasks(weekData.tasks,tasksForWeek(start).filter(t=>!weekData.suppressedOrigins?.includes(t.originKey)));
    if (merged.length === weekData.tasks.length) return {data:weekData,sha:weekSha};
    const value = {...weekData,tasks:merged};
    const path = `planner/weeks/${start}.md`, text = plannerSerialize(value);
    const saved = await commitVaultEntries(`Add project tasks to ${start}`,[{path,text}],[{path,sha:weekSha}]);
    register(path,saved[0].sha,text);
    return {data:value,sha:saved[0].sha};
  }
  async function open() {
    await plannerFlush();
    await load(true);
    await refreshCompletion();
    render();
  }
  async function refreshCompletion() {
    // Derive progress from the saved weekly checkboxes, including other devices.
    const keys = new Map();
    const paths = state.notes.filter(n => /^planner\/weeks\/\d{4}-\d{2}-\d{2}\.md$/.test(n.path));
    for (const note of paths) {
      const file = await fetchFile(note.path);
      if (!file) continue;
      const start = note.path.slice(-13,-3);
      const value = plannerParse(file.text,start);
      for (const task of value.tasks) if (task.hubTaskId && !value.carriedTaskIds?.includes(task.id)) {
        const row = keys.get(task.hubTaskId) || {total:0,done:0};
        row.total++; if (task.done) row.done++; keys.set(task.hubTaskId,row);
      }
    }
    for (const task of data.tasks) {
      task.progress = keys.get(task.id) || {total:0,done:0};
      if ((!task.repeat || task.repeat==='none') && task.progress.total) task.done = task.progress.done === task.progress.total;
    }
  }
  async function save(candidate, previous = data) {
    if (busy) throw new Error('Дождись сохранения предыдущего изменения.');
    busy = true; $('hubSaveBtn').disabled = true;
    try {
      await plannerFlush();
      const starts = new Set(state.notes.filter(n => /^planner\/weeks\/\d{4}-\d{2}-\d{2}\.md$/.test(n.path)).map(n => n.path.slice(-13,-3)));
      for (const task of [...(previous?.tasks || []),...candidate.tasks]) if (validDate(task.date)) starts.add(weekStart(task.date));
      const entries = [], expected = [], weekly = [];
      const today = new Date();
      const current = ctx.plannerCurrentWeekStart(today);
      const oldIds = new Set((previous?.tasks || []).map(t => t.id));
      const sourceById = new Map(candidate.tasks.map(t => [t.id,t]));
      for (const start of [...starts].sort()) {
        const path = `planner/weeks/${start}.md`, file = await fetchFile(path);
        const value = file ? plannerParse(file.text,start) : plannerEmptyData(start);
        const additions = start < current || value.closedAt ? [] : hubTasksForWeek(candidate.tasks,start,id).filter(t=>!value.suppressedOrigins?.includes(t.originKey));
        const byKey = new Map(additions.map(t => [t.originKey,t]));
        const tasks = value.tasks.flatMap(task => {
          if (!task.hubTaskId || !oldIds.has(task.hubTaskId)) return [task];
          const source = sourceById.get(task.hubTaskId);
          if (start < current || value.closedAt || task.done) return [task];
          if (task.originKey?.startsWith('carry:') && source && !source.done) {
            return source.updatedAt === task.hubRevision ? [task] : [{...task,text:source.text,duration:source.duration,projectId:source.projectId,hubRevision:source.updatedAt || ''}];
          }
          const incoming = byKey.get(task.originKey);
          if (!incoming) return source?.done && (!source.repeat || source.repeat==='none') ? [{...task,done:true}] : [];
          if (task.hubRevision === incoming.hubRevision) return [task];
          return [{...task,...incoming,id:task.id,done:task.done}];
        });
        value.tasks = mergeWeekTasks(tasks,additions);
        if (JSON.stringify(value.tasks) === JSON.stringify(file ? plannerParse(file.text,start).tasks : [])) continue;
        const text = plannerSerialize(value);
        entries.push({path,text}); expected.push({path,sha:file?.sha || null}); weekly.push({path,start,value});
      }
      // One commit for project data and all scheduled instances prevents partial plans.
      const text = serialize(candidate);
      entries.push({path:PATH,text}); expected.push({path:PATH,sha});
      const saved = await commitVaultEntries('Update future tasks and projects',entries,expected);
      for (const entry of entries) register(entry.path,saved.find(e=>e.path===entry.path).sha,entry.text);
      data = candidate; sha = saved.find(e=>e.path===PATH).sha;
      const opened = weekly.find(w=>w.path===state.planner.path);
      if (opened) { state.planner.data=opened.value; state.planner.sha=saved.find(e=>e.path===opened.path).sha; plannerRender(); }
      render();
    } finally { busy = false; $('hubSaveBtn').disabled = false; }
  }
  function populateProjects(element, selected = '') {
    element.innerHTML = `<option value="">Без проекта</option>`+data.projects.map(p=>`<option value="${h(p.id)}">${h(p.name)}</option>`).join('');
    element.value = selected;
  }
  function projectSelect(selected = '') {
    populateProjects($('hubProject'), selected);
  }
  function render() {
    $('hubProjects').innerHTML = '';
    for (const project of [{id:'all',name:'Все дела'},{id:'future',name:'Будущие события'},...data.projects]) {
      const button=document.createElement('button'); button.className=`hub-project ${filter===project.id?'active':''}`;
      const count=data.tasks.filter(t=>!t.done && (project.id==='all' || project.id==='future' && t.kind==='event' || t.projectId===project.id)).length;
      button.innerHTML=`<span>${h(project.name)}</span><span class="muted">${count}</span>`;
      button.onclick=()=>{filter=project.id;render();}; $('hubProjects').appendChild(button);
    }
    const query=$('hubSearch').value.trim().toLocaleLowerCase('ru');
    const tasks=data.tasks.filter(t=>(filter==='all' || filter==='future' && t.kind==='event' || t.projectId===filter) && ($('hubShowDone').checked || !t.done) && t.text.toLocaleLowerCase('ru').includes(query)).sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999'));
    $('hubList').innerHTML='';
    $('hubHeading').textContent=filter==='all'?'Все дела':filter==='future'?'Будущие события':data.projects.find(p=>p.id===filter)?.name || 'Дела';
    if (!tasks.length) $('hubList').innerHTML='<p class="hub-empty muted">Пока нет дел. Добавь задачу или событие.</p>';
    for (const task of tasks) {
      const row=document.createElement('article'); row.className=`hub-task ${task.done?'done':''}`;
      const project=data.projects.find(p=>p.id===task.projectId)?.name || 'Без проекта';
      const prep=task.kind==='event' ? (task.prepDays && task.prepHours?`Подготовка: ${task.prepDays} дней · ${task.prepHours} ч`:'Подготовка: уточнить срок и время') : '';
      row.innerHTML=`<input type="checkbox" aria-label="Дело выполнено" ${task.done?'checked':''}><button class="hub-task-edit"><strong>${h(task.text)}</strong><span class="muted small">${h(dateLabel(task.date))} · ${h(project)}${task.repeat==='daily'?' · каждый день':task.repeat==='weekly'?' · каждую неделю':''}${task.duration?` · ${task.duration} мин`:''}</span>${prep?`<span class="hub-prep ${task.prepDays && task.prepHours?'':'pending'}">${h(prep)}</span>`:''}${task.progress?.total?`<span class="muted small">В неделях: ${task.progress.done}/${task.progress.total} выполнено</span>`:''}</button>`;
      row.querySelector('button').onclick=()=>openModal(task);
      row.querySelector('input').onchange=async e=>{
        const candidate=structuredClone(data); candidate.tasks.find(t=>t.id===task.id).done=e.target.checked;
        try { await save(candidate); } catch(err) { render(); showToast(`Не сохранено: ${err.message}`); }
      };
      $('hubList').appendChild(row);
    }
  }
  function toggleKind() {
    const event=$('hubKind').value==='event';
    $('hubPreparation').classList.toggle('hidden',!event);
    $('hubRepeat').disabled=event;
  }
  function openModal(task = null) {
    if (busy) return;
    editing=task?.id || null;
    $('hubModalTitle').textContent=task?'Редактировать дело':'Новое дело';
    $('hubText').value=task?.text || ''; $('hubKind').value=task?.kind || 'task';
    $('hubDate').value=task?.date || ''; $('hubTime').value=task?.time || '';
    $('hubDuration').value=task?.duration || ''; $('hubRepeat').value=task?.repeat || 'none';
    $('hubSection').value=task?.section || 'general';
    $('hubPrepDays').value=task?.prepDays || ''; $('hubPrepHours').value=task?.prepHours || '';
    $('hubSteps').value=task?.prepSteps || ''; $('hubBuildPrep').checked=false;
    $('hubDeleteBtn').classList.toggle('hidden',!task);
    projectSelect(task?.projectId || (data.projects.some(p=>p.id===filter)?filter:''));
    toggleKind(); $('hubModal').classList.remove('hidden'); $('hubText').focus();
  }
  function closeModal() { if (!busy) {$('hubModal').classList.add('hidden');editing=null;} }
  async function submit() {
    const text=$('hubText').value.trim(), date=$('hubDate').value, kind=$('hubKind').value;
    if (!text) return showToast('Напиши название дела.');
    if (date && !validDate(date)) return showToast('Проверь дату.');
    if (kind==='event' && !date) return showToast('Укажи дату события.');
    const candidate=structuredClone(data), existing=candidate.tasks.find(t=>t.id===editing);
    const task={...(existing || {}),id:existing?.id || id(),updatedAt:new Date().toISOString(),text,kind,date,projectId:$('hubProject').value,time:$('hubTime').value,duration:Math.max(0,Number($('hubDuration').value)||0),section:$('hubSection').value,repeat:kind==='event'?'none':$('hubRepeat').value,done:existing?.done || false,prepDays:Number($('hubPrepDays').value)||null,prepHours:Number($('hubPrepHours').value)||null,prepSteps:$('hubSteps').value};
    if (task.repeat!=='none' && !date) return showToast('Для повторяющегося дела укажи дату первого появления.');
    if ($('hubBuildPrep').checked && kind==='event') {
      if (candidate.tasks.some(t=>t.eventId===task.id)) return showToast('Подготовка уже создана. Измени её задачи в списке проекта.');
      try { candidate.tasks.push(...preparationTasks(task,task.prepSteps.split('\n'),task.prepDays,task.prepHours,id)); }
      catch(e) { return showToast(e.message); }
    }
    if (existing) Object.assign(existing,task); else candidate.tasks.push(task);
    try { await save(candidate); closeModal(); showToast('Дело сохранено. Датированные задачи добавлены в недели.'); }
    catch(e) { showToast(`Не сохранено: ${e.message}. Введённые данные остаются в форме.`); }
  }
  $('hubAddBtn').onclick=()=>openModal(); $('hubKind').onchange=toggleKind;
  $('hubSaveBtn').onclick=submit; $('hubCancelBtn').onclick=closeModal; $('hubCloseBtn').onclick=closeModal;
  $('hubModal').addEventListener('click',e=>{if(e.target===$('hubModal'))closeModal();});
  $('hubSearch').oninput=()=>data && render(); $('hubShowDone').onchange=()=>data && render();
  $('hubRefreshBtn').onclick=()=>open().catch(e=>showToast(e.message));
  $('hubNewProjectBtn').onclick=async()=>{
    if (busy) return;
    const raw=prompt('Название нового проекта'); if (!raw?.trim()) return;
    const name=raw.trim(); if (data.projects.some(p=>p.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru'))) return showToast('Такой проект уже есть.');
    const candidate=structuredClone(data), project={id:id(),name}; candidate.projects.push(project);
    try { await save(candidate); filter=project.id;render(); } catch(e){showToast(e.message);}
  };
  $('hubDeleteBtn').onclick=async()=>{
    if (busy || !editing || !confirm('Удалить дело и его незавершённые появления в будущих неделях? Выполненные дела останутся в истории.')) return;
    const candidate=structuredClone(data); candidate.tasks=candidate.tasks.filter(t=>t.id!==editing && t.eventId!==editing);
    try { await save(candidate);closeModal(); } catch(e){showToast(e.message);}
  };
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});
  return controller;
}
