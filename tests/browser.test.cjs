/* Optional browser checks: PLAYWRIGHT_MODULE may point to a local Playwright install.
   All GitHub requests are intercepted. These tests never use a real vault or token. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const sha=text=>crypto.createHash('sha1').update(text).digest('hex');
const week=(start,tasks)=>`# Week\n<!-- NOTE_PLANNER_STATE:${Buffer.from(JSON.stringify({version:1,weekStart:start,tasks})).toString('base64')} -->\n`;
const files=new Map(),blobs=new Map(),trees=new Map(),commits=new Map();
let revision=0,head='',failPut=false,failRef=false;
function blob(text){const key=sha(text);blobs.set(key,text);return key;}
function setFile(name,text){files.set(name,{path:name,type:'blob',mode:'100644',sha:blob(text),size:Buffer.byteLength(text)});}
function snapshot(parent=head){const tree='tree-'+(++revision);trees.set(tree,new Map([...files].map(([k,v])=>[k,{...v}])));head='commit-'+revision;commits.set(head,{sha:head,tree:{sha:tree},parents:[parent]});}
function task(id,text,more={}){return {id,text,day:0,section:'general',time:'',duration:30,repeat:'none',done:false,order:1,...more};}
setFile('Заметки/Идея.md','# Идея\n[[План|мой план]]\n[План](../Проекты/План.md)');
setFile('Проекты/План.md','# План\n[[Заметки/Идея]]');
setFile('Проекты/Вложенная/image.png','image');
setFile('Проекты/Пустая/.gitkeep','');
setFile('planner/weeks/2026-10-05.md',week('2026-10-05',[task('carry','Перенести меня'),task('leave','Оставить в истории'),task('routine','Еженедельное',{repeat:'weekly',recurrenceId:'routine',day:2}),task('done','Выполнено',{done:true})]));
setFile('planner/weeks/2026-10-12.md',week('2026-10-12',[task('existing','Уже запланировано',{day:1})]));snapshot();
const server=http.createServer((req,res)=>{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html';
  const target=path.resolve(root,name);
  if (!target.startsWith(root+path.sep) || !fs.existsSync(target)) {res.writeHead(404);return res.end();}
  let body=fs.readFileSync(target);
  if(name==='app.js') body=Buffer.from(body.toString()+`\nwindow.__test={state,els,relocateFolder,plannerOpenWeek,plannerFlush,plannerFinalizeWeek,plannerParse,plannerSerialize,taskHub,buildGraph};`);
  res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':/\.(mjs|js)$/.test(name)?'text/javascript':'application/octet-stream');res.end(body);
});
async function api(route){
  const req=route.request(),url=new URL(req.url()),endpoint=decodeURIComponent(url.pathname).replace(/^\/repos\/test\/vault/,'');
  const body=req.postDataJSON(),method=req.method();
  const send=(obj,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(obj)});
  if(!endpoint)return send({default_branch:'main'});
  if(endpoint==='/branches/main')return send({commit:{sha:head,commit:{tree:commits.get(head).tree}}});
  if(endpoint==='/git/ref/heads/main')return send({object:{sha:head}});
  if(endpoint.startsWith('/git/commits/') && method==='GET')return send(commits.get(endpoint.split('/').pop()));
  if(endpoint.startsWith('/git/trees/') && method==='GET')return send({tree:[...trees.get(endpoint.split('/').pop()).values()],truncated:false});
  if(endpoint==='/git/blobs' && method==='POST')return send({sha:blob(body.content)},201);
  if(endpoint==='/git/trees' && method==='POST'){
    const value=new Map(trees.get(body.base_tree));
    for(const item of body.tree)if(item.sha===null)value.delete(item.path);else value.set(item.path,{...item,size:Buffer.byteLength(blobs.get(item.sha)||'')});
    const key='tree-'+(++revision);trees.set(key,value);return send({sha:key},201);
  }
  if(endpoint==='/git/commits' && method==='POST'){
    const key='commit-'+(++revision);commits.set(key,{sha:key,tree:{sha:body.tree},parents:body.parents});return send({sha:key},201);
  }
  if(endpoint==='/git/refs/heads/main' && method==='PATCH'){
    if(failRef || commits.get(body.sha).parents[0]!==head)return send({message:'Conflict'},422);
    head=body.sha;files.clear();for(const [k,v]of trees.get(commits.get(head).tree.sha))files.set(k,{...v});return send({object:{sha:head}});
  }
  if(endpoint.startsWith('/contents/')){
    const name=endpoint.slice('/contents/'.length),entry=files.get(name);
    if(method==='GET')return entry?send({type:'file',sha:entry.sha,content:Buffer.from(blobs.get(entry.sha)).toString('base64')}):send({message:'Not Found'},404);
    if(method==='PUT'){
      if(failPut)return send({message:'Test save failure'},503);
      if(entry && entry.sha!==body.sha)return send({message:'SHA conflict'},409);
      setFile(name,Buffer.from(body.content,'base64').toString('utf8'));snapshot();return send({content:{sha:files.get(name).sha}},201);
    }
    if(method==='DELETE'){files.delete(name);snapshot();return send({});}
  }
  return send({message:'Unhandled mock endpoint '+method+' '+endpoint},500);
}
function readWeek(start){const text=blobs.get(files.get(`planner/weeks/${start}.md`).sha);return JSON.parse(Buffer.from(text.match(/NOTE_PLANNER_STATE:([^ ]+)/)[1],'base64').toString());}
async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
  try{
    const context=await browser.newContext({timezoneId:'Asia/Krasnoyarsk',viewport:{width:1440,height:950}});
    await context.route('https://api.github.com/**',api);
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install({time:new Date('2026-10-11T12:00:00+07:00')});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.__test,{timeout:60000});
    await page.locator('#ownerInput').fill('test');await page.locator('#repoInput').fill('vault');await page.locator('#tokenInput').fill('test-token');await page.locator('#connectBtn').click();
    await page.locator('#appView').waitFor({state:'visible'});
    assert.equal(await page.locator('.folder-row.open').count(),0,'folders start collapsed');
    await page.locator('.folder-row').filter({hasText:'Заметки'}).click();
    await page.reload();await page.waitForFunction(()=>window.__test && !document.querySelector('#appView').classList.contains('hidden'));
    assert.equal(await page.locator('.folder-row.open').filter({hasText:'Заметки'}).count(),1,'folder state persists for this vault');
    await page.locator('#graphModeBtn').click();await page.waitForFunction(()=>window.__test.state.graph.links.length>=2);
    assert.ok(await page.locator('.graph-link').count()>=2);console.log('PASS graph renders linked saved notes');
    failRef=true;
    const failure=await page.evaluate(()=>window.__test.relocateFolder('Проекты','Новая').then(()=>false,()=>true));
    assert.equal(failure,true);assert.ok(files.has('Проекты/План.md'));assert.ok(!files.has('Новая/План.md'));failRef=false;
    await page.evaluate(()=>window.__test.relocateFolder('Проекты','Новая'));
    assert.ok(files.has('Новая/Вложенная/image.png'));assert.ok(files.has('Новая/Пустая/.gitkeep'));assert.ok(![...files.keys()].some(p=>p.startsWith('Проекты/')));
    assert.ok(blobs.get(files.get('Заметки/Идея.md').sha).includes('%D0%9D%D0%BE%D0%B2%D0%B0%D1%8F'));
    await page.evaluate(()=>window.__test.buildGraph(true));assert.ok(await page.locator('.graph-link').count()>=2);console.log('PASS atomic folder rename, updated links and failed-ref preservation');
    await page.locator('#plannerModeBtn').click();await page.waitForFunction(()=>window.__test.state.planner.data);
    await page.locator('#plannerReviewBtn').click();assert.equal(await page.locator('.planner-carry-check:checked').count(),0);
    await page.locator('.planner-carry-check[data-task-id="carry"]').check();await page.locator('#plannerFinalizeWeekBtn').click();
    await page.waitForFunction(()=>window.__test.state.planner.weekStart==='2026-10-12');
    let next=readWeek('2026-10-12');assert.ok(next.tasks.some(t=>t.id==='existing'));assert.ok(next.tasks.some(t=>t.text==='Перенести меня'));assert.ok(!next.tasks.some(t=>t.text==='Оставить в истории'));assert.equal(next.tasks.filter(t=>t.text==='Еженедельное').length,1);
    await page.evaluate(()=>window.__test.plannerOpenWeek('2026-10-05'));await page.locator('#plannerReviewBtn').click();await page.locator('.planner-carry-check[data-task-id="carry"]').check();await page.locator('#plannerFinalizeWeekBtn').click();await page.waitForFunction(()=>window.__test.state.planner.weekStart==='2026-10-12');
    next=readWeek('2026-10-12');assert.equal(next.tasks.filter(t=>t.text==='Перенести меня').length,1);assert.equal(next.tasks.filter(t=>t.text==='Еженедельное').length,1);console.log('PASS selected carry into existing week and repeat closure');
    await page.clock.setSystemTime(new Date('2026-10-12T12:00:00+07:00'));
    await page.reload();await page.waitForFunction(()=>window.__test && !document.querySelector('#appView').classList.contains('hidden'));
    await page.locator('#plannerModeBtn').click();await page.waitForFunction(()=>window.__test.state.planner.data?.weekStart==='2026-10-12');
    assert.ok(await page.locator('.planner-task-text').filter({hasText:'Перенести меня'}).count());console.log('PASS Monday reload retains saved tasks');
    const check=page.locator('.planner-task-row').first();
    await page.evaluate(()=>{const p=window.__test.state.planner;p.data.tasks.push({id:'rapid',text:'Сохранить перед переходом',day:0,section:'general',repeat:'none',done:false});p.dirty=true;p.revision=(p.revision||0)+1;});
    await page.evaluate(()=>window.__test.plannerOpenWeek('2026-10-19'));assert.ok(readWeek('2026-10-12').tasks.some(t=>t.id==='rapid'));
    await page.evaluate(()=>window.__test.plannerOpenWeek('2026-10-12'));
    failPut=true;await page.evaluate(()=>{window.__test.state.planner.data.tasks[0].text='Не терять при ошибке';window.__test.state.planner.dirty=true;});
    const blocked=await page.evaluate(()=>window.__test.plannerOpenWeek('2026-10-19').then(()=>false,()=>true));assert.equal(blocked,true);assert.equal(await page.evaluate(()=>window.__test.state.planner.weekStart),'2026-10-12');failPut=false;await page.evaluate(()=>window.__test.plannerFlush());console.log('PASS navigation saves pending changes and stops on failed save');
    await page.locator('#futureModeBtn').click();await page.locator('.hub-project').filter({hasText:'Медиакружок'}).waitFor();
    await page.locator('#hubAddBtn').click();await page.locator('#hubText').fill('Конференция медиакружка');await page.locator('#hubKind').selectOption('event');await page.locator('#hubProject').selectOption('media');await page.locator('#hubDate').fill('2026-10-26');await page.locator('#hubSection').selectOption('meetings');await page.locator('#hubPrepDays').fill('7');await page.locator('#hubPrepHours').fill('6');await page.locator('#hubSteps').fill('Заявка\nМатериалы\nДоклад');await page.locator('#hubBuildPrep').check();await page.locator('#hubSaveBtn').click();await page.locator('#hubModal').waitFor({state:'hidden'});
    assert.ok(files.has('planner/projects.md'));assert.ok(readWeek('2026-10-26').tasks.some(t=>t.text==='Конференция медиакружка'));assert.equal(readWeek('2026-10-19').tasks.filter(t=>['Заявка','Материалы','Доклад'].includes(t.text)).length,3);console.log('PASS event and preparation schedule saved in private vault');
    await page.locator('#hubAddBtn').click();await page.locator('#hubText').fill('Публикация медиакружка');await page.locator('#hubProject').selectOption('media');await page.locator('#hubDate').fill('2026-10-14');await page.locator('#hubRepeat').selectOption('weekly');await page.locator('#hubSaveBtn').click();await page.locator('#hubModal').waitFor({state:'hidden'});
    await page.evaluate(()=>window.__test.plannerOpenWeek('2026-11-02'));await page.evaluate(()=>window.__test.taskHub.ensureWeek('2026-11-02',window.__test.plannerParse('','2026-11-02'),null));assert.ok(readWeek('2026-11-02').tasks.some(t=>t.text==='Публикация медиакружка'));console.log('PASS project routine persists into later weeks');
    await page.locator('.hub-task-edit').filter({hasText:'Публикация медиакружка'}).click();await page.locator('#hubText').fill('Обновлённая публикация');await page.locator('#hubSaveBtn').click();await page.locator('#hubModal').waitFor({state:'hidden'});
    assert.ok(readWeek('2026-11-02').tasks.some(t=>t.text==='Обновлённая публикация'));
    await page.locator('#plannerModeBtn').click();await page.waitForFunction(()=>window.__test.state.planner.data?.weekStart==='2026-11-02');
    const row=page.locator('.planner-task').filter({hasText:'Обновлённая публикация'});
    await row.locator('.planner-task-menu').click();await page.locator('#plannerTaskModal').waitFor({state:'visible'});
    assert.equal(await page.locator('#plannerTaskProject').inputValue(),'media');
    await page.locator('#plannerDeleteTaskBtn').click();await page.evaluate(()=>window.__test.plannerFlush());
    await page.evaluate(()=>window.__test.plannerOpenWeek('2026-11-02'));
    assert.ok(!readWeek('2026-11-02').tasks.some(t=>t.text==='Обновлённая публикация'));console.log('PASS project edits update future weeks and deleted occurrences stay deleted');
    await page.locator('#futureModeBtn').click();await page.locator('.hub-task-edit').filter({hasText:'Конференция медиакружка'}).waitFor();
    await page.setViewportSize({width:390,height:844});
    await page.clock.runFor(3000);
    await page.locator('#hubAddBtn').click();
    assert.ok(await page.locator('#hubSaveBtn').isVisible());
    await page.locator('#hubCancelBtn').click();
    await page.screenshot({path:path.resolve(root,'../mobile-preview.png'),fullPage:true,animations:'disabled'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'mobile layout stays within viewport');
    assert.deepEqual(errors,[]);console.log('PASS mobile layout and no runtime errors');
    await page.setViewportSize({width:1440,height:950});await page.screenshot({path:path.resolve(root,'../desktop-preview.png'),fullPage:true});
  }finally{await browser.close();}
}
main().then(()=>server.close(),e=>{console.error(e);server.close();process.exitCode=1;});
