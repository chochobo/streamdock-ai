import test from 'node:test';
import assert from 'node:assert/strict';
import {featureItems} from '../src/feature-pages.mjs';

test('memory bytes and usage percentage describe the same observation', () => {
 const GiB = 1024 ** 3;
 const key = machine => featureItems('machines', { machine }).find(x => x.id === 'machine-memory');
 const sample = { memoryUsedBytes: 8 * GiB, memoryTotalBytes: 32 * GiB, memoryUsedPercent: 25 };
 assert.deepEqual(key(sample).memory, { usedBytes: 8 * GiB, totalBytes: 32 * GiB, estimated: true });
 assert.equal(key(sample).bar.value, 25);
 const stale = key({ ...sample, metricStatus: { memoryUsedPercent: 'stale' } });
 assert.deepEqual(stale.memory, key(sample).memory);
 assert.equal(stale.bar.stale, true);
 const zero = key({ memoryUsedBytes: 0, memoryTotalBytes: 32 * GiB, memoryUsedPercent: 0 });
 assert.equal(zero.memory.usedBytes, 0);
 assert.equal(zero.bar.value, 0);
 const full = key({ memoryUsedBytes: 32 * GiB, memoryTotalBytes: 32 * GiB, memoryUsedPercent: 100 });
 assert.equal(full.memory.usedBytes, 32 * GiB);
 assert.equal(full.bar.value, 100);
 for (const bad of [
   { ...sample, memoryUsedPercent: 26 }, { ...sample, memoryUsedPercent: 25.1 }, { ...sample, memoryUsedBytes: null },
   { ...sample, memoryUsedBytes: -1 }, { ...sample, memoryUsedBytes: 8.5 },
   { ...sample, memoryTotalBytes: 0 }, { ...sample, memoryUsedBytes: 33 * GiB },
   { ...sample, memoryUsedPercent: null }, { ...sample, metricStatus: { memoryUsedPercent: 'unavailable' } },
 ]) assert.equal(key(bad).memory, undefined);
 assert.equal(key({ ...sample, metricStatus: { memoryUsedPercent: 'unavailable' } }).bar, undefined);
});

test('machine metrics distinguish missing measurements from zero',()=>{
 const r=featureItems('machines',{machine:{cpuPercent:0,memoryUsedPercent:null,disk:{usedPercent:45},networkHasAddress:false,battery:{percent:null}}});
 assert.equal(r.find(x=>x.id==='machine-cpu').caption,'0%');
 assert.equal(r.find(x=>x.id==='machine-memory').caption,'미확인');
 assert.equal(r.find(x=>x.id==='machine-disk').caption,'사용 45%');
 assert.equal(r.find(x=>x.id==='machine-network').caption,'주소 없음');
 assert.ok(r.filter(x=>x.id.startsWith('machine-')).every(x=>x.enabled===false));
 assert.deepEqual(r.filter(x=>x.action?.startsWith('cleanup:prepare:')).map(x=>x.action),['cleanup:prepare:clean','cleanup:prepare:purge','cleanup:prepare:trash']);
});
test('timer actions follow actual state with no automatic start',()=>{
 const running=featureItems('pomodoro',{pomodoro:{state:'running',remainingSeconds:61}});
 assert.equal(running[0].caption,'01:01');
 assert.ok(running.some(x=>x.action==='pomodoro:pause'));
 assert.ok(!running.some(x=>x.action==='pomodoro:resume'));
 assert.ok(running.some(x=>x.action==='pomodoro:start:25'));
 const paused=featureItems('pomodoro',{pomodoro:{state:'paused',remainingSeconds:30}});
 assert.ok(paused.some(x=>x.action==='pomodoro:resume'));
});

test('timer presets are validated and running controls stay on the first page', () => {
 const presets=[5,10,15,20,25,30,45,50,60,90];
 const items=featureItems('pomodoro',{pomodoro:{state:'running',remainingSeconds:50,presets}});
 assert.equal(items.length,12);
 assert.deepEqual(items.slice(0,2).map(x=>x.id),['timer-current','timer-reset']);
 assert.equal(items[0].action,'pomodoro:pause');
 assert.deepEqual(items.slice(2).map(x=>x.action),presets.map(x=>`pomodoro:start:${x}`));
 const filtered=featureItems('pomodoro',{pomodoro:{state:'paused',remainingSeconds:4,presets:[5,5,10,'15',0,200]}});
 assert.deepEqual(filtered.slice(0,2).map(x=>x.id),['timer-current','timer-reset']);
 assert.equal(filtered[0].action,'pomodoro:resume');
 assert.deepEqual(filtered.slice(2).map(x=>x.action),['pomodoro:start:5','pomodoro:start:10']);
});
test('market values use supplied quotes and show stale and provider times',()=>{
 const r=featureItems('market',{market:{view:'top',status:'stale',source:'Naver',marketStatus:'CLOSE',quotes:[{kind:'stock',name:'A',price:1200,changePercent:-1.2,quoteTime:'2026-11-06 15:30:00'}]}});
 assert.equal(r[0].action,'market:next');assert.equal(r[1].action,'market:refresh');
 assert.equal(r[2].action,'market:heattab');assert.equal(r[3].caption,'비공식');assert.equal(r[4].caption,'-1.20%');assert.match(r[4].detail,/오래된 값/);assert.match(r[4].detail,/2026-11-06/);assert.match(r[4].detail,/CLOSE/);
});

test('market tiles use movement colors and only stock tiles open HeatTab', () => {
  const quotes = [
    {kind:'stock',name:'Up',price:100,changePercent:1},
    {kind:'stock',name:'Down',price:100,changePercent:-1},
    {kind:'stock',name:'Flat',price:100,changePercent:0},
    {kind:'index',name:'Index',price:100,changePercent:1},
    {kind:'stock',name:'No change',price:100,changePercent:null},
  ];
  const items = featureItems('market', {market:{status:'ok',view:'top',quotes}});
  const tiles = items.filter(x => x.id.startsWith('market-quote-'));
  assert.deepEqual(tiles.map(x => x.state),['market-up','market-down','market-flat','market-up','unknown']);
  assert.equal(tiles[0].action,'market:heattab');
  assert.equal(tiles[3].action,undefined);
  const stale = featureItems('market',{market:{status:'stale',view:'top',quotes}});
  assert.ok(stale.filter(x => x.id.startsWith('market-quote-')).every(x => x.state==='unknown'));
});
test('settings language control uses saved language and explicit action', () => {
  for(const [language,caption] of [['ko','한국어'],['en','English']]) {
    const key = featureItems('settings',{settings:{language}}).find(x=>x.id==='settings-language');
    assert.equal(key.caption,caption);
    assert.equal(key.action,'settings:language');
  }
  assert.equal(featureItems('settings',{settings:{}}).find(x=>x.id==='settings-language').action,undefined);
});
test('parcel UI does not invent delivery dates and requires configured opt-in for refresh',()=>{
 const no=featureItems('parcels',{parcels:{status:'ok',trackingEnabled:false,parcels:[{title:'상품',state:'in_transit',eta:null}]}});
 assert.ok(!no.some(x=>x.action==='parcels:refresh'));assert.match(no[0].detail,/예정일 미확인/);
 const yes=featureItems('parcels',{parcels:{status:'ok',trackingEnabled:true,parcels:[]}});
 assert.equal(yes[0].action,'parcels:refresh');assert.match(yes[0].detail,/전송/);
});
test('feature menus expose only explicit, non-destructive actions',()=>{
 assert.ok(featureItems('games').some(x=>x.action==='game:mole'));
 assert.ok(featureItems('scenes').some(x=>x.action==='scene:aquarium'));
 assert.ok(featureItems('remote').every(x=>!x.enabled));
 assert.equal(featureItems('settings')[0].caption,'미확인');
 assert.equal(featureItems('settings')[0].enabled,false);
});
test('summary counts loaded top-level sessions only, not historical or child sessions',()=>{
 const r=featureItems('summary',{agents:[{presence:'live',status:'working'},{presence:'unknown',status:'working'},{presence:'live',status:'working',isSubagent:true}]});
 assert.equal(r.find(x=>x.id==='summary-working').caption,'1');
});
test('worktree page accepts scanner items and never enables removal by itself',()=>{
 const r=featureItems('worktrees',{worktrees:{items:[{id:'abc',name:'branch-one',state:'dirty',reasons:['변경 있음']},{id:'def',name:'clean',state:'removable',reasons:[]}]}});
 assert.equal(r[0].caption,'변경 있음');assert.equal(r[1].caption,'정리 가능');assert.ok(r.every(x=>!x.enabled));
});
test('remote page requires a separate confirmation and shows host and operation',()=>{
 const id='1234567890abcdef1234';const remote={status:'configured',hosts:[{id,label:'작업실',operations:['machine','agents','agy']}],observations:[]};
 const first=featureItems('remote',{remote});assert.equal(first.length,3);assert.equal(first[0].action,`remote:prepare:${id}:machine`);assert.equal(first[0].caption,'머신');assert.ok(!first.some(x=>x.action?.startsWith('remote:confirm:')));
 const second=featureItems('remote',{remote:{...remote,confirmation:{id,operation:'machine'}}});assert.equal(second[0].label,'작업실');assert.equal(second[0].caption,'머신');assert.equal(second[0].enabled,false);assert.equal(second[1].label,'앱 검토 필요');assert.ok(!second.some(x=>x.action?.startsWith('remote:confirm:')));assert.equal(second[2].action,'remote:cancel');
 const reviewed=featureItems('remote',{remote:{...remote,confirmation:{id,operation:'machine',reviewed:true}}});assert.equal(reviewed[1].action,`remote:confirm:${id}:machine`);assert.equal(reviewed[1].caption,'머신');
 const invalid=featureItems('remote',{remote:{...remote,confirmation:{id,operation:'bad'}}});assert.ok(!invalid.some(x=>x.action?.startsWith('remote:confirm:')));
});
test('remote quota windows and stale observations use returned data only',()=>{
 const id='1234567890abcdef1234';const remote={hosts:[{id,label:'서버',operations:['agy']}],observations:[{id,operation:'agy',status:'stale',observedAt:'2026-11-09T00:00:00Z',data:{windows:[{label:'모델',window:'weekly',usedPercent:25,resetsAt:'2026-11-13T03:00:00Z'}]}}]};
 const r=featureItems('remote',{remote});assert.equal(r[0].caption,'AGY 한도');const quota=r.find(x=>x.id.endsWith('-agy-0'));assert.equal(quota.caption,'25% 사용');assert.match(quota.detail,/오래됨/);assert.equal(quota.enabled,false);
});
test('credits page uses only explicitly supplied service balances',()=>{
 const r=featureItems('credits',{credits:{services:[{id:'a',label:'A',status:'ok',balance:0},{id:'b',label:'B',status:'not-configured',balance:null},{id:'c',label:'C',status:'stale',balance:10,resetAt:'2026-11-12T00:00:00Z',resetQuality:'source-estimate'}]}});
 assert.equal(r[0].caption,'0');assert.equal(r[1].caption,'설정 필요');assert.equal(r[2].caption,'10');assert.match(r[2].detail,/리셋 추정/);assert.ok(r.every(x=>!x.enabled));
});
test('summary includes usage from multiple providers',()=>{
 const r=featureItems('summary',{usage:{accounts:[{provider:'codex',label:'Codex',status:'ok',windows:[{label:'7일',usedPercent:12}]},{provider:'claude',label:'Claude',status:'ok',windows:[{label:'7일',usedPercent:8}]}]}});
 assert.ok(r.some(x=>x.label==='Codex'&&x.caption==='12%'&&x.action==='summary:usage'));
 assert.ok(r.some(x=>x.label==='Claude'&&x.caption==='8%'&&x.action==='summary:usage'));
 for(const key of r.filter(x=>['summary-working','summary-blocked','summary-done','summary-unknown'].includes(x.id))) assert.equal(key.action,'summary:projects');
});
test('credit reset display text is preserved without inventing a date',()=>{
 const out=featureItems('credits',{credits:{services:[{id:'foo',label:'Foo',status:'ok',balance:4,resetAt:null,resetLabel:'매월 7일',resetQuality:'displayed-text'}]}});
 assert.match(out[0].detail,/리셋 매월 7일/);assert.doesNotMatch(out[0].detail,/리셋 추정/);
});
test('sound setting defaults off and shows saved on/off state without playing',()=>{
 const off=featureItems('settings',{settings:{sound:{enabled:false}}});assert.equal(off.find(x=>x.id==='settings-sound').caption,'꺼짐');assert.equal(off.find(x=>x.id==='settings-sound').action,'settings:sound');
 const on=featureItems('settings',{settings:{sound:{enabled:true},brightness:75}});assert.equal(on.find(x=>x.id==='settings-sound').caption,'켜짐');const brightness=on.find(x=>x.id==='settings-brightness');assert.equal(brightness.caption,'75% 저장');assert.equal(brightness.enabled,false);
});
test('screensaver and brightness controls use actual settings and confirmed capability',()=>{
 const s={sound:{enabled:false},screensaver:{enabled:true,idleMinutes:5,scene:'rain'},brightness:50,capabilities:{brightness:true}};
 const x=featureItems('settings',{settings:s});assert.equal(x.find(v=>v.id==='settings-screen').caption,'켜짐');assert.equal(x.find(v=>v.id==='settings-screen').action,'settings:screen:toggle');
 assert.equal(x.find(v=>v.id==='settings-idle-5').caption,'선택됨');assert.equal(x.find(v=>v.id==='settings-idle-1').action,'settings:screen:idle:1');
 assert.equal(x.find(v=>v.id==='settings-scene-rain').caption,'선택됨');assert.equal(x.find(v=>v.id==='settings-scene-beach').action,'settings:screen:scene:beach');
 assert.equal(x.filter(v=>v.action?.startsWith('settings:brightness:')).length,4);assert.equal(x.find(v=>v.id==='settings-brightness-50').caption,'선택됨');
 const unknown=featureItems('settings',{settings:{sound:{enabled:false},screensaver:{enabled:false,idleMinutes:15,scene:'aquarium'},brightness:50}});assert.ok(!unknown.some(v=>v.action?.startsWith('settings:brightness:')));assert.match(unknown.find(v=>v.id==='settings-brightness').detail,/실제 장치 밝기/);
});
test('cleanup review requires whole web review and a complete eligible plan',()=>{
 const plan={kind:'trash',count:2,estimatedBytes:2048,targets:[{path:'/Users/test/.Trash/A'},{path:'/Users/test/.Trash/B'}],executable:true,scope:'휴지통을 영구 삭제합니다.',reasons:[]};
 const unreviewed=featureItems('machines',{cleanup:{stage:'review',plan,reviewed:false}});
 assert.ok(unreviewed.some(x=>x.label==='영구 삭제'));assert.equal(unreviewed.find(x=>x.id==='cleanup-review-count').caption,'2개');assert.equal(unreviewed.find(x=>x.id==='cleanup-review-size').caption,'2.0KB');
 assert.equal(unreviewed.find(x=>x.id==='cleanup-target-0').detail,'/Users/test/.Trash/A');assert.ok(!unreviewed.some(x=>x.action==='cleanup:confirm'));assert.ok(unreviewed.some(x=>x.action==='cleanup:cancel'));
 const reviewed=featureItems('machines',{cleanup:{stage:'review',plan,reviewed:true}});assert.equal(reviewed.find(x=>x.action==='cleanup:confirm').label,'검토 확인');
 const final=featureItems('machines',{cleanup:{stage:'confirm_again',plan,reviewed:true}});assert.equal(final.find(x=>x.action==='cleanup:confirm').label,'영구 삭제');
 const changed=featureItems('machines',{cleanup:{stage:'review',plan:{...plan,count:3},reviewed:true}});assert.ok(!changed.some(x=>x.action==='cleanup:confirm'));
 const blocked=featureItems('machines',{cleanup:{stage:'review',plan:{...plan,executable:false},reviewed:true}});assert.ok(!blocked.some(x=>x.action==='cleanup:confirm'));
});
test('cleanup rejects unreviewable target names and does not invent bytes',()=>{
 const p={kind:'clean',count:1,estimatedBytes:null,executable:true,targets:[{path:'/tmp/bad\nname'}]};
 const out=featureItems('machines',{cleanup:{stage:'review',plan:p,reviewed:true}});
 assert.ok(!out.some(x=>x.action==='cleanup:confirm'));assert.equal(out.find(x=>x.id==='cleanup-review-size').caption,'미확인');
});
test('only eligible worktree with valid identity and path can begin review',()=>{
 const id='wt-'+'a'.repeat(24);const data={items:[{id,name:'feature',path:'/tmp/repo/feature',state:'removable',eligible:true,reasons:[]},{id:'other',name:'blocked',path:'/tmp/repo/blocked',state:'dirty',eligible:false}]};
 const out=featureItems('worktrees',{worktrees:data});assert.equal(out[0].action,`worktree:prepare:${id}`);assert.match(out[0].detail,/\/tmp\/repo\/feature/);assert.equal(out[1].enabled,false);
});
test('worktree removal needs full path, eligibility and explicit web review',()=>{
 const plan={id:'wt-'+'a'.repeat(24),action:'git worktree remove',name:'feature',path:'/tmp/repo/feature',eligible:true,executable:true,deletesBranch:false,scope:'워크트리 파일을 삭제합니다.'};
 const pre=featureItems('worktrees',{worktrees:{review:{stage:'review',plan,reviewed:false}}});assert.equal(pre.find(x=>x.id==='worktree-review-target').detail,plan.path);assert.ok(!pre.some(x=>x.action==='worktree:confirm'));
 const yes=featureItems('worktrees',{worktrees:{review:{stage:'confirm_again',plan,reviewed:true}}});assert.equal(yes.find(x=>x.action==='worktree:confirm').label,'파일 삭제');
 const bad=featureItems('worktrees',{worktrees:{review:{stage:'review',plan:{...plan,path:'relative'},reviewed:true}}});assert.ok(!bad.some(x=>x.action==='worktree:confirm'));
});
test('summary only displays returned pace and comparable recommendation',()=>{
 const usage={accounts:[{provider:'codex',label:'Codex',status:'ok',windows:[{label:'7일',usedPercent:20}]}],pace:{accounts:[{provider:'codex',label:'Codex',windows:[{label:'7일',pace:{classification:'fast',deltaPercentPoints:12}},{label:'5시간',pace:null}]}],recommendation:{label:'Codex',remainingPercent:80,durationMinutes:10080}}};
 const out=featureItems('summary',{usage});const pace=out.find(x=>x.id==='summary-pace-0-0');assert.equal(pace.caption,'빠름');assert.match(pace.detail,/\+12\.0%p/);assert.ok(!out.some(x=>x.id==='summary-pace-0-1'));const rec=out.find(x=>x.id==='summary-recommendation');assert.equal(rec.caption,'Codex');assert.match(rec.detail,/모델·권한·비용은 미반영/);assert.ok(out.length<=12);
 const unknown=featureItems('summary',{usage:{accounts:[],pace:{accounts:[],recommendation:null}}});assert.ok(!unknown.some(x=>x.id==='summary-recommendation'));
});
test('portfolio consent screen lists all explicit symbols before the send action',()=>{
 const symbols=Array.from({length:10},(_,i)=>String(i).padStart(6,'0'));
 const out=featureItems('market',{market:{view:'portfolio',status:'consent_required',portfolioSymbols:symbols}});
 assert.equal(out.length,14);assert.equal(out[0].label,'NAVER');assert.equal(out[1].action,'market:next');assert.deepEqual(out.slice(2,12).map(x=>x.label),symbols);assert.ok(out.slice(2,12).every(x=>!x.enabled));
 assert.equal(out[12].caption,'반복 조회');assert.match(out[12].detail,/60초/);assert.equal(out[13].label,'NAVER');assert.equal(out[13].action,'market:portfolio:confirm');assert.match(out[13].detail,/60초마다 재조회/);
 const invalid=featureItems('market',{market:{view:'portfolio',status:'consent_required',portfolioSymbols:['005930','bad;inject']}});assert.ok(!invalid.some(x=>x.action==='market:portfolio:confirm'));
});
test('unverified cleanup and worktree plans are preview-only',()=>{
 const cleanup={stage:'review',reviewed:true,plan:{kind:'trash',count:1,targets:[{path:'/tmp/file'}],estimatedBytes:1,executable:false,reasons:['실행 불가']}};
 const a=featureItems('machines',{cleanup});assert.ok(a.some(x=>x.label==='실행 불가'));assert.ok(!a.some(x=>x.action==='cleanup:confirm'));
 const id='wt-'+'a'.repeat(24);const worktrees={items:[{id,name:'x',path:'/tmp/x',state:'reviewable',eligible:true,executable:false}]};
 const b=featureItems('worktrees',{worktrees});assert.equal(b[0].caption,'검토 가능');assert.equal(b[0].action,`worktree:prepare:${id}`);
 const c=featureItems('worktrees',{worktrees:{review:{stage:'review',reviewed:true,plan:{id,path:'/tmp/x',eligible:true,executable:false,blockedReason:'안전성 미검증'}}}});assert.ok(c.some(x=>x.label==='실행 불가'));assert.ok(!c.some(x=>x.action==='worktree:confirm'));
});
test('updates require a configured and explicitly enabled remote check',()=>{
 const none=featureItems('settings',{settings:{sound:{enabled:false},screensaver:{enabled:false,idleMinutes:15,scene:'aquarium'}}});assert.ok(!none.some(x=>x.action==='update:check'));assert.equal(none.find(x=>x.id==='settings-update').enabled,false);
 const available=featureItems('settings',{settings:{sound:{enabled:false},screensaver:{enabled:false,idleMinutes:15,scene:'aquarium'},update:{configured:true,status:'update_available',canCheck:true,canPrepare:true}}});assert.ok(available.some(x=>x.action==='update:check'));assert.ok(available.some(x=>x.action==='update:prepare'));assert.ok(!available.some(x=>x.action==='update:apply'));
 const blocked=featureItems('settings',{settings:{sound:{enabled:false},screensaver:{enabled:false,idleMinutes:15,scene:'aquarium'},update:{configured:true,status:'update_available',canCheck:false,canPrepare:false}}});assert.ok(!blocked.some(x=>x.action?.startsWith('update:')));
});
test('parcel import key is only shown after explicit local opt-in',()=>{
 const no=featureItems('parcels',{parcels:{status:'unconfigured'}});assert.ok(!no.some(x=>x.action==='parcels:import'));
 const yes=featureItems('parcels',{parcels:{status:'unconfigured',importAvailable:true}});assert.equal(yes[0].action,'parcels:import');assert.match(yes[0].detail,/미리|확인/);
});

test('machine screen displays external drives and marks incomplete scans', () => {
 const items=featureItems('machines',{machine:{externalDrives:{status:'partial',items:[{name:'Archive',usedPercent:65,availableBytes:1073741824}]}}});
 const drive=items.find(x=>x.id==='machine-drive-0');
 assert.equal(drive.label,'Archive'); assert.equal(drive.caption,'사용 65%'); assert.equal(drive.detail,'여유 1.0GB');
 assert.equal(items.find(x=>x.id==='machine-drive-status').caption,'일부 미확인');
});


test('stale machine metrics retain numbers but mark graph and text as old', () => {
  const machine = { cpuPercent: 10, memoryUsedPercent: 70, disk: { usedPercent: 32 }, battery: { percent: 90 },
    networkHasAddress: true, healthScore: 80, thermalC: 44,
    externalDrives: { status:'ok', items:[{ name:'A', usedPercent:20 }] },
    metricStatus: { cpuPercent:'ok', memoryUsedPercent:'stale', disk:'stale', battery:'stale',
      networkHasAddress:'stale', healthScore:'stale', thermalC:'stale', externalDrives:'stale' } };
  const rows = featureItems('machines', { machine });
  const byId = id => rows.find(row=>row.id===id);
  assert.equal(byId('machine-cpu').bar.stale,undefined);
  for(const id of ['machine-memory','machine-disk','machine-battery','machine-health','machine-drive-0']) {
    assert.equal(byId(id).bar.stale,true);
    assert.equal(byId(id).state,'unknown');
    assert.match(byId(id).detail,/이전 값/);
  }
  assert.equal(byId('machine-network').caption,'이전');
  assert.equal(byId('machine-temp').caption,'이전');
});
