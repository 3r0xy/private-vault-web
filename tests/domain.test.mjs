import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveNote,noteLinks,folderMoveEntries,mergeWeekTasks,preparationTasks,weekStart,rewriteFolderLinks} from '../domain.mjs';
import {hubTasksForWeek} from '../task-hub.mjs';

const notes=[{path:'Проекты/Конференция.md'},{path:'Проекты/План.md'},{path:'Личное/План.md'},{path:'Идея.md'}];
test('graph resolves full, relative, encoded, alias, heading and case-insensitive links',()=>{
  assert.equal(resolveNote('Проекты/Конференция#Доклад|событие','Идея.md',notes),'Проекты/Конференция.md');
  assert.equal(resolveNote('./%D0%9F%D0%BB%D0%B0%D0%BD.md','Проекты/Конференция.md',notes,true),'Проекты/План.md');
  assert.equal(resolveNote('../Идея.md','Проекты/Конференция.md',notes,true),'Идея.md');
  assert.equal(resolveNote('План','Проекты/Конференция.md',notes),'Проекты/План.md');
  assert.equal(resolveNote('План','Идея.md',notes),null);
  assert.equal(resolveNote('/Идея.md','Проекты/Конференция.md',notes,true),'Идея.md');
  assert.equal(resolveNote('проекты/конференция','Идея.md',notes),'Проекты/Конференция.md');
  assert.equal(resolveNote('https://example.com','Идея.md',notes,true),null);
});
test('graph reads wiki and Markdown references but ignores examples and image assets',()=>{
  const links=noteLinks('[[Идея]] [План](./План.md) ![[file.png]] ![image](file.jpg)\n```md\n[[Пример]]\n```\n`[[код]]` ![[Конференция]]');
  assert.deepEqual(links,[{target:'Идея',relative:false},{target:'Конференция',relative:false},{target:'./План.md',relative:true}]);
});
test('folder rename reuses blobs and removes every old path in the same tree',()=>{
  const files=[{path:'Старая/A.md',sha:'a'},{path:'Старая/Папка/image.png',sha:'b'},{path:'Другая/B.md',sha:'c'}];
  const entries=folderMoveEntries(files,'Старая','Новая');
  assert.equal(entries.length,4);
  assert.deepEqual(entries.filter(e=>e.sha).map(e=>e.path),['Новая/A.md','Новая/Папка/image.png']);
  assert.deepEqual(entries.filter(e=>e.sha===null).map(e=>e.path),['Старая/A.md','Старая/Папка/image.png']);
  assert.throws(()=>folderMoveEntries(files,'Старая','Старая/Внутри'));
  assert.throws(()=>folderMoveEntries(files,'Старая','Другая'));
});
test('closing into an existing week preserves tasks and deduplicates repeated closure',()=>{
  const existing=[{id:'already',text:'Понедельник',done:true}];
  const additions=[{id:'carry1',originKey:'carry:2026-09-28:t1',done:false},{id:'repeat1',recurrenceId:'weekly1',day:2,done:false}];
  const once=mergeWeekTasks(existing,additions);
  const twice=mergeWeekTasks(once,additions.map(t=>({...t,id:'retry'+t.id})));
  assert.equal(twice.length,3);assert.equal(twice[0].done,true);
  assert.deepEqual(existing,[{id:'already',text:'Понедельник',done:true}]);
});
test('folder rename updates resolved full wiki paths and relative Markdown references',()=>{
  assert.equal(rewriteFolderLinks('[[Проекты/Конференция#Доклад|событие]] [План](Проекты/План.md) `[[Проекты/План]]`','Идея.md',notes,'Проекты','Работа'),'[[Работа/Конференция#Доклад|событие]] [План](%D0%A0%D0%B0%D0%B1%D0%BE%D1%82%D0%B0/%D0%9F%D0%BB%D0%B0%D0%BD.md) `[[Проекты/План]]`');
  assert.equal(rewriteFolderLinks('[Идея](../Идея.md)','Проекты/План.md',notes,'Проекты','Работа/Новая'),'[Идея](../../%D0%98%D0%B4%D0%B5%D1%8F.md)');
});
test('preparation dates precede event and effort is split across steps',()=>{
  let next=0;
  const steps=preparationTasks({id:'event',date:'2026-10-19',projectId:'media'},['Заявка','Материалы','Доклад'],7,6,()=>String(++next));
  assert.deepEqual(steps.map(t=>t.date),['2026-10-12','2026-10-14','2026-10-16']);
  assert.equal(steps.reduce((s,t)=>s+t.duration,0),360);
  assert.ok(steps.every(t=>t.projectId==='media' && t.eventId==='event'));
  assert.throws(()=>preparationTasks({date:'2026-02-30'},['x'],2,1,()=>''));
});
test('project routines continue week to week with stable identities and completed ones stop',()=>{
  const templates=[{id:'routine',text:'Публикация',date:'2026-10-07',repeat:'weekly',projectId:'media'},{id:'event',text:'Конференция',date:'2026-10-12',repeat:'none'},{id:'stop',date:'2026-10-05',repeat:'daily',done:true}];
  const first=hubTasksForWeek(templates,'2026-10-05',()=>Math.random().toString());
  const second=hubTasksForWeek(templates,'2026-10-12',()=>Math.random().toString());
  assert.equal(first.length,1);assert.equal(first[0].day,2);
  assert.equal(second.length,2);assert.equal(second[1].day,0);
  assert.equal(mergeWeekTasks(second,hubTasksForWeek(templates,'2026-10-12',()=>'' )).length,2);
  assert.equal(weekStart('2026-10-11'),'2026-10-05');
  assert.equal(weekStart('2026-10-12'),'2026-10-12');
});
