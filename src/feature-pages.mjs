// Pure rendering model: these helpers never contact a service or mutate state.
const clean=(value,max=80)=>typeof value==='string'?Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu,' ').trim()).slice(0,max).join(''):'';
const finite=(value,min=-Infinity,max=Infinity)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?value:null;
const percent=value=>{const n=finite(value,0,100);return n===null?'미확인':`${Math.round(n)}%`;};
const item=(id,label,caption,detail='',state='idle',action=null)=>({id,label,caption,detail,state,kind:'feature',enabled:!!action,...(action?{action}:{})});
const placeholder=(id,label,detail='정보를 확인할 수 없습니다.')=>item(id,label,'미확인',detail,'unknown');
function time(value){const n=finite(value,0,180*60);if(n===null)return '미확인';const s=Math.ceil(n);return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
const fmtPrice=value=>{const n=finite(value);return n===null?'미확인':new Intl.NumberFormat('ko-KR',{maximumFractionDigits:3}).format(n);};
const fmtChange=value=>{const n=finite(value,-10000,10000);return n===null?'미확인':`${n>0?'+':''}${n.toFixed(2)}%`;};
const exactPath=value=>typeof value==='string' && value.startsWith('/') && value.length<=4096 && !/[\p{Cc}\p{Cf}]/u.test(value)?value:null;
function bytes(value) {
  const n=finite(value,0,Number.MAX_SAFE_INTEGER);if(n===null)return '미확인';
  if(n<1024)return `${Math.round(n)}B`;
  const units=['KB','MB','GB','TB'];let v=n/1024,i=0;
  while(v>=1024&&i<units.length-1){v/=1024;i++;}
  return `${v>=10?Math.round(v):v.toFixed(1)}${units[i]}`;
}
const cleanupNames={clean:'캐시 정리',purge:'산출물 정리',trash:'휴지통'};
function cleanupReview(review) {
  const plan=review?.plan,stage=review?.stage;
  if(!plan||typeof plan!=='object'||!['review','confirm_again'].includes(stage))return [item('cleanup-cancel','취소','누르기','정리 검토를 취소합니다.','idle','cleanup:cancel')];
  const kind=cleanupNames[plan.kind]||'정리';
  const count=Number.isSafeInteger(plan.count)&&plan.count>=0?plan.count:null;
  const targets=Array.isArray(plan.targets)?plan.targets:[];
  const valid=count!==null&&count===targets.length&&count>0&&targets.every(target=>exactPath(target?.path));
  const items=[
    item('cleanup-review-scope',plan.executable===false?'실행 불가':'영구 삭제',kind,clean(plan.scope,200)||'정리 대상의 미리보기입니다.','error'),
    item('cleanup-review-count','삭제 대상',count===null?'미확인':`${count}개`,'전체 대상은 앱에서 확인하세요.','blocked'),
    item('cleanup-review-size','예상 용량',bytes(plan.estimatedBytes),'예상값이며 실제 확보 용량은 다를 수 있습니다.','idle'),
  ];
  const eligible=Object.hasOwn(cleanupNames,plan.kind)&&plan.executable===true&&valid&&review.reviewed===true;
  if(eligible)items.push(item('cleanup-confirm',stage==='confirm_again'?'영구 삭제':'검토 확인',stage==='confirm_again'?'최종 확인':'한 번 더 확인','앱에서 전체 경로를 확인한 다음 진행하세요.','error','cleanup:confirm'));
  else items.push(placeholder('cleanup-web-review',plan.executable===false?'실행 불가':'앱 검토 필요',plan.executable===false?'삭제 계획을 실행할 수 없습니다.':'앱에서 전체 경로를 확인하세요.'));
  items.push(item('cleanup-cancel','취소','누르기','정리 검토를 취소합니다.','idle','cleanup:cancel'));
  for(const [i,target] of targets.slice(0,5).entries()){
    const path=exactPath(target?.path);
    items.push(item(`cleanup-target-${i}`,path?path.split('/').filter(Boolean).pop()||'/':'경로 미확인',`대상 ${i+1}`,path||'경로를 확인할 수 없습니다.','unknown'));
  }
  if(targets.length>5)items.push(item('cleanup-more','나머지 대상',`${targets.length-5}개`,'전체 경로는 앱에서 확인하세요.','unknown'));
  for(const [i,reason] of (Array.isArray(plan.reasons)?plan.reasons.slice(0,2):[]).entries())items.push(item(`cleanup-reason-${i}`,'실행 제한','확인 필요',clean(reason,200),'blocked'));
  return items;
}
const VIEWS=['top','kosdaq','movers','portfolio','sectors','macro'];
const VIEW_NAME={top:'코스피',kosdaq:'코스닥',movers:'업종 등락',portfolio:'포트폴리오',sectors:'관심 업종',macro:'환율·원자재'};
const STATES={working:'작업',blocked:'확인',done:'완료',idle:'대기',unknown:'미확인',error:'오류'};
// A graph is present only when its value is measured and has a known meaning.
// Match the rounded number displayed on the key exactly.
function withBar(tile, value, direction, warningAt, criticalAt, stale = false) {
  const measured = finite(value, 0, 100);
  return measured === null ? tile : { ...tile, bar: { value: Math.round(measured), direction, warningAt, criticalAt, ...(stale ? { stale: true } : {}) } };
}

function machineItems(machine,cleanup) {
  if(cleanup && ['review','confirm_again'].includes(cleanup.stage))return cleanupReview(cleanup);
  const actions=[item('cleanup-clean','캐시 정리','검토','삭제 계획만 만들고 실행하지 않습니다.','idle','cleanup:prepare:clean'),item('cleanup-purge','산출물 정리','검토','삭제 계획만 만들고 실행하지 않습니다.','idle','cleanup:prepare:purge'),item('cleanup-trash','휴지통','검토','홈 휴지통 영구 삭제 계획만 확인합니다.','idle','cleanup:prepare:trash')];
  if(!machine||typeof machine!=='object')return [placeholder('machine-unavailable','머신'),...actions];
  const cpu=finite(machine.cpuPercent,0,100), disk=finite(machine.disk?.usedPercent,0,100), memory=machine.metricStatus?.memoryUsedPercent==='unavailable'?null:finite(machine.memoryUsedPercent,0,100), battery=finite(machine.battery?.percent,0,100);
  const stale=field=>machine.metricStatus?.[field]==='stale';
  const details=(text,field)=>stale(field)?`${text} · 이전 값`:text;
  const state=(value,field)=>value===null||stale(field)?'unknown':'idle';
  const network=machine.networkHasAddress===true?'주소 있음':machine.networkHasAddress===false?'주소 없음':'미확인';
  const usedBytes=finite(machine.memoryUsedBytes,0,Number.MAX_SAFE_INTEGER), totalBytes=finite(machine.memoryTotalBytes,1,Number.MAX_SAFE_INTEGER);
  const memoryValue=memory!==null && Number.isSafeInteger(usedBytes) && Number.isSafeInteger(totalBytes) && totalBytes>0 && usedBytes>=0 && usedBytes<=totalBytes && Math.abs(100*usedBytes/totalBytes-memory)<1e-6
    ? {usedBytes,totalBytes,estimated:true} : null;
  const memoryDetail=memoryValue!==null
    ? `macOS 물리 메모리 사용량 추정 ${(usedBytes / (1024 ** 3)).toFixed(1)} / ${(totalBytes / (1024 ** 3)).toFixed(1)} GB`
    : 'macOS 물리 메모리 사용량 추정';
  const list=[
    withBar(item('machine-cpu','CPU',percent(cpu),details('전체 코어의 사용자와 시스템 CPU 사용률 합계','cpuPercent'),state(cpu,'cpuPercent')),cpu,'used',70,90,stale('cpuPercent')),
    { ...withBar(item('machine-memory','메모리 사용',memory===null?'미확인':`약 ${percent(memory)}`,details(memoryDetail,'memoryUsedPercent'),state(memory,'memoryUsedPercent')),memory,'used',75,90,stale('memoryUsedPercent')), ...(memoryValue ? { memory: memoryValue } : {}) },
    withBar(item('machine-disk','디스크',disk===null?'미확인':`사용 ${percent(disk)}`,details('시스템 데이터 볼륨','disk'),state(disk,'disk')),disk,'used',80,90,stale('disk')),
    item('machine-network','네트워크',stale('networkHasAddress')?'이전':network,details('외부 인터페이스의 주소 존재 여부','networkHasAddress'),state(machine.networkHasAddress ?? null,'networkHasAddress')),
    withBar(item('machine-battery','배터리',battery===null?'미확인':percent(battery),details('장치가 보고한 배터리','battery'),state(battery,'battery')),battery,'charge',80,90,stale('battery')),
  ];
  const temp=finite(machine.thermalC,1,150);if(temp!==null)list.push(item('machine-temp','온도',stale('thermalC')?'이전':`${Math.round(temp)}°C`,details('제공된 CPU 온도','thermalC'),state(temp,'thermalC')));
  const score=finite(machine.healthScore,0,100);if(score!==null)list.push(withBar(item('machine-health','건강 점수',`${Math.round(score)}`,details(clean(machine.healthSource)||'외부 도구','healthScore'),state(score,'healthScore')),score,'score',80,90,stale('healthScore')));
  if (machine.externalDrives && Array.isArray(machine.externalDrives.items)) {
    machine.externalDrives.items.slice(0, 16).forEach((drive, i) => {
      const used = finite(drive?.usedPercent, 0, 100);
      list.push(withBar(item(`machine-drive-${i}`, clean(drive?.name) || '외장 드라이브', used === null ? '미확인' : `사용 ${percent(used)}`,
        details(drive?.availableBytes == null ? '외장 드라이브' : `여유 ${bytes(drive.availableBytes)}`,'externalDrives'), state(used,'externalDrives')),used,'used',80,90,stale('externalDrives')));
    });
    if (machine.externalDrives.status !== 'ok') list.push(item('machine-drive-status', '외장 드라이브', '일부 미확인', '연결된 드라이브를 모두 확인하지 못했습니다.', 'unknown'));
  }
  return [...list,...actions];
}
function timerItems(timer) {
  if(!timer||typeof timer!=='object')return [placeholder('timer-unavailable','타이머')];
  const state=['idle','running','paused','done'].includes(timer.state)?timer.state:'unknown';
  const status={idle:'대기',running:'진행 중',paused:'일시정지',done:'완료',unknown:'미확인'}[state];
  const currentAction=state==='running'?'pomodoro:pause':state==='paused'?'pomodoro:resume':null;
  const currentDetail=state==='running'?'누르면 일시정지':state==='paused'?'누르면 계속':status;
  const items=[item('timer-current','남은 시간',time(timer.remainingSeconds),currentDetail,state==='running'?'working':state==='done'?'done':state==='unknown'?'unknown':'idle',currentAction)];
  if(state!=='unknown')items.push(item('timer-reset','초기화','누르기','타이머 초기화','idle','pomodoro:reset'));
  const supported=[5,10,15,20,25,30,45,50,60,90];
  const presets=Array.isArray(timer.presets)?[...new Set(timer.presets.filter(v=>Number.isInteger(v)&&supported.includes(v)))]:supported;
  for(const minutes of presets) items.push(item(`timer-start-${minutes}`,`${minutes}분`, '시작', `${minutes}분 타이머 시작`, 'idle', `pomodoro:start:${minutes}`));
  return items;
}
function marketItems(market) {
  const view=VIEWS.includes(market?.view)?market.view:'top';
  if(view==='portfolio'&&market?.status==='consent_required'){
    const raw=market.portfolioSymbols;
    const valid=Array.isArray(raw)&&raw.length>0&&raw.length<=10&&new Set(raw).size===raw.length&&raw.every(v=>typeof v==='string'&&/^[A-Za-z0-9.\\-]{1,16}$/.test(v));
    const items=[item('market-consent-info','NAVER','종목 전송','설정한 종목 코드를 네이버에 전송합니다.','blocked'),item('market-consent-cancel','취소','다음 보기','종목을 전송하지 않고 다음 보기로 이동합니다.','idle','market:next')];
    if(valid){
      for(const [i,symbol] of raw.entries())items.push(item(`market-consent-symbol-${i}`,symbol,'전송 대상',`네이버에 전송할 종목 코드: ${symbol}`,'blocked'));
      items.push(item('market-consent-frequency','60초','반복 조회','확인 후 이 화면에 머무는 동안 60초마다 네이버에 재조회합니다.','blocked'));
      items.push(item('market-consent-confirm','NAVER','전송 확인',`네이버에 종목 전송 후 이 화면에서 60초마다 재조회합니다. 코드: ${raw.join(', ')}`,'blocked','market:portfolio:confirm'));
    } else items.push(placeholder('market-consent-invalid','종목 미확인','전송할 종목을 확인할 수 없어 조회하지 않습니다.'));
    return items;
  }
  const list=[item('market-view',VIEW_NAME[view], '보기 전환','다음 시장 보기','idle','market:next'),item('market-refresh','시세 갱신','누르기','네이버 금융 비공식 공개 시세를 다시 조회','idle','market:refresh'),item('market-heat','HeatTab','열기','기본 브라우저에서 heattab.app을 엽니다.','idle','market:heattab'),item('market-source','NAVER','비공식','제공 시각과 지연 여부를 확인하세요.','unknown')];
  if(!market||!['ok','stale'].includes(market.status))return [...list,placeholder('market-unavailable',market?.status==='unconfigured'?'설정 필요':'시세',market?.status==='unconfigured'?'선택한 보기의 종목이나 업종이 설정되지 않았습니다.':'시세를 확인할 수 없습니다.')];
  const quotes=Array.isArray(market.quotes)?market.quotes.slice(0,10):[];
  for(let index=0;index<quotes.length;index++){
    const q=quotes[index];if(!q||typeof q!=='object')continue;
    const change=finite(q.changePercent,-10000,10000),price=finite(q.price);
    if(change===null&&price===null)continue;
    const label=clean(q.name,60)||`항목 ${index+1}`;
    const caption=q.kind==='macro'?fmtPrice(price):fmtChange(change);
    const detail=[q.kind==='macro'?fmtChange(change):price===null?'':`가격 ${fmtPrice(price)}`,clean(q.quoteTime,40)?`기준 ${clean(q.quoteTime,40)}`:'',market.status==='stale'?'오래된 값':'',clean(q.marketStatus||market.marketStatus,20)].filter(Boolean).join(' · ');
    const state=market.status==='stale'||change===null?'unknown':change>0?'market-up':change<0?'market-down':'market-flat';
    list.push(item(`market-quote-${index}`,label,caption,detail,state,q.kind==='stock'?'market:heattab':undefined));
  }
  if(list.length===4)list.push(placeholder('market-empty','시세'));
  return list;
}
function parcelItems(data) {
  const importItem=data?.importAvailable===true?item('parcels-import','알리 가져오기','미리보기','사용자가 연 전용 배송 탭을 읽고 적용 전 앱에서 확인합니다.','idle','parcels:import'):null;
  if(!data||data.status==='unconfigured')return [...(importItem?[importItem]:[]),placeholder('parcels-unconfigured','택배 설정','택배 정보가 등록되지 않았습니다.')];
  if(data.status==='unavailable')return [...(importItem?[importItem]:[]),placeholder('parcels-unavailable','택배','택배 상태를 확인할 수 없습니다.')];
  const rows=Array.isArray(data.parcels)?data.parcels.slice(0,40):[];
  const labels={delivered:'도착',out_for_delivery:'배송 출발',customs:'통관',in_transit:'운송 중',shipped:'발송',exception:'배송 오류',unknown:'미확인'};
  const list=rows.map((p,i)=>{
    const state=Object.hasOwn(labels,p?.state)?p.state:'unknown';
    const eta=typeof p?.eta==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(p.eta)?p.eta:null;
    return item(`parcel-${i}`,clean(p?.title,60)||'택배',labels[state],[eta?`예정 ${eta}`:'예정일 미확인',data.status==='stale'?'오래된 값':''].filter(Boolean).join(' · '),state==='delivered'?'done':state==='exception'?'error':state==='unknown'?'unknown':'idle');
  });
  if(!list.length)list.push(placeholder('parcels-empty','택배 없음','등록된 택배가 없습니다.'));
  if(data.trackingEnabled===true)list.unshift(item('parcels-refresh','배송 조회','누르기','등록한 운송장 번호를 배송 조회 서비스에 전송합니다.','idle','parcels:refresh'));
  if(importItem)list.unshift(importItem);
  return list;
}
function worktreeReview(review) {
  const plan=review?.plan,stage=review?.stage;
  if(!plan||typeof plan!=='object'||!['review','confirm_again'].includes(stage))return [item('worktree-cancel','취소','누르기','워크트리 검토를 취소합니다.','idle','worktree:cancel')];
  const path=exactPath(plan.path);
  const label=path?path.split('/').filter(Boolean).pop()||'/':'경로 미확인';
  const items=[
    item('worktree-review-scope',plan.executable===false?'실행 불가':'파일 삭제',plan.executable===false?'미리보기':'브랜치 유지',plan.executable===false?(clean(plan.blockedReason,200)||'안전성 검증 전에는 실행할 수 없습니다.'):'워크트리 파일을 삭제합니다. 전체 경로는 앱에서 확인하세요.','error'),
    item('worktree-review-target',label,'대상 경로',path||'정확한 경로를 확인할 수 없습니다.','blocked'),
  ];
  const eligible=review.reviewed===true&&plan.executable===true&&plan.eligible===true&&!!path&&plan.deletesBranch===false
    && plan.action==='git worktree remove' && typeof plan.id==='string' && /^wt-[a-f0-9]{24}$/.test(plan.id);
  if(eligible)items.push(item('worktree-confirm',stage==='confirm_again'?'파일 삭제':'검토 확인',stage==='confirm_again'?'최종 확인':'한 번 더 확인','앱에서 전체 경로를 확인한 다음 진행하세요.','error','worktree:confirm'));
  else items.push(placeholder('worktree-web-review',plan.executable===false||plan.eligible===false?'실행 불가':'앱 검토 필요',plan.executable===false?(clean(plan.blockedReason,200)||'안전성 검증 전에는 실행할 수 없습니다.'):plan.eligible===false?'워크트리 제거 조건을 만족하지 않습니다.':'앱에서 전체 경로를 확인하세요.'));
  items.push(item('worktree-cancel','취소','누르기','워크트리 검토를 취소합니다.','idle','worktree:cancel'));
  for(const [i,reason] of (Array.isArray(plan.reasons)?plan.reasons.slice(0,2):[]).entries())items.push(item(`worktree-reason-${i}`,'실행 제한','확인 필요',clean(reason,200),'blocked'));
  return items;
}
function worktreeItems(data) {
  if(data?.review && ['review','confirm_again'].includes(data.review.stage))return worktreeReview(data.review);
  const trees=Array.isArray(data?.items)?data.items:Array.isArray(data?.worktrees)?data.worktrees:Array.isArray(data)?data:[];
  if(!trees.length)return [placeholder('worktrees-empty',data?.status==='unavailable'?'조회 불가':'워크트리 없음')];
  const states={active:'사용 중',dirty:'변경 있음',ignored:'확인 필요',main:'주 작업',reviewable:'검토 가능',removable:'정리 가능',stale:'오래됨',unmerged:'미병합',locked:'잠김',unknown:'미확인'};
  return trees.slice(0,100).map((tree,i)=>{
    const state=typeof tree.state==='string'?tree.state:tree.status;
    const id=clean(tree.id,60)||String(i);
    const path=exactPath(tree.path);
    const reason=Array.isArray(tree.reasons)?tree.reasons.map(x=>clean(x,60)).filter(Boolean).join(' · '):clean(tree.detail,100);
    const detail=[path||'경로 미확인',reason].filter(Boolean).join(' · ');
    const action=tree.eligible===true && /^wt-[a-f0-9]{24}$/.test(id) && path ? `worktree:prepare:${id}` : null;
    return item(`worktree-${id}`,clean(tree.name||tree.branch||tree.label,60)||`워크트리 ${i+1}`,states[state]||'미확인',detail,state==='active'?'working':state==='dirty'||state==='ignored'?'blocked':state==='unknown'||!states[state]?'unknown':'idle',action);
  });
}
function summaryItems({agents,usage}) {
  const live=(Array.isArray(agents)?agents:[]).filter(a=>a&&!a.isSubagent&&a.presence==='live');
  const counts={working:0,blocked:0,done:0,unknown:0};for(const a of live)if(Object.hasOwn(counts,a.status))counts[a.status]++;
  const list=['working','blocked','done','unknown'].map(status=>{
    const inferred=status!=='unknown' && live.some(a=>a.status===status && a.confidence==='inferred');
    return item(`summary-${status}`,STATES[status],`${counts[status]}${inferred?'?':''}`,`열린 상위 세션 기준${inferred?' · 추정 포함':''}`,status==='working'?'working':status==='blocked'?'blocked':status==='done'?'done':'unknown','summary:projects');
  });
  let usageCount=0;
  for(const [i,account] of (Array.isArray(usage?.accounts)?usage.accounts:[]).entries())for(const [j,window] of (Array.isArray(account?.windows)?account.windows:[]).entries()){
    if(usageCount>=4)break;if(!window||typeof window!=='object')continue;usageCount++;
    const stale=account.status==='stale'||window.status==='stale';
    const n=account.status==='unavailable'||window.status==='unavailable'?null:finite(window.usedPercent,0,100);
    const detail=[clean(window.label,30),stale?'이전 값':''].filter(Boolean).join(' · ');
    list.push(withBar(item(`summary-usage-${i}-${j}`,clean(account.label,40)||clean(account.provider,20),n===null?'미확인':`${Math.round(n)}%`,detail,stale||n===null?'unknown':'idle','summary:usage'),n,'used',60,85,stale));
  }
  const labels={fast:'빠름',on_track:'적정',relaxed:'여유'};
  let paceCount=0;
  for(const [i,account] of (Array.isArray(usage?.pace?.accounts)?usage.pace.accounts:[]).entries())for(const [j,window] of (Array.isArray(account?.windows)?account.windows:[]).entries()){
    if(paceCount>=3)break;
    const pace=window?.pace,classification=pace?.classification;
    if(!pace||!Object.hasOwn(labels,classification)||finite(pace.deltaPercentPoints,-100,100)===null)continue;
    paceCount++;
    const detail=[clean(window.label,30),'기간 대비 사용 속도',`${pace.deltaPercentPoints>=0?'+':''}${pace.deltaPercentPoints.toFixed(1)}%p`].filter(Boolean).join(' · ');
    list.push(item(`summary-pace-${i}-${j}`,clean(account.label,40)||clean(account.provider,20)||'계정',labels[classification],detail,classification==='fast'?'blocked':classification==='relaxed'?'working':'idle','summary:usage'));
  }
  const rec=usage?.pace?.recommendation;
  const remaining=finite(rec?.remainingPercent,0,100);
  if(rec&&typeof rec==='object'&&clean(rec.label,40)&&remaining!==null&&Number.isInteger(rec.durationMinutes)&&rec.durationMinutes>0){
    list.push(item('summary-recommendation','한도 여유',clean(rec.label,40),`같은 기간 사용률만 비교 · 남음 ${Math.round(remaining)}% · 모델·권한·비용은 미반영`,'idle','summary:usage'));
  }
  return list;
}

function remoteItems(remote) {
  const hosts=Array.isArray(remote?.hosts)?remote.hosts.filter(h=>h && /^[a-f0-9]{20}$/.test(h.id) && typeof h.label==='string').slice(0,8):[];
  if(!hosts.length)return [placeholder('remote-unconfigured',remote?.status==='unavailable'?'원격 조회 불가':'원격 설정','원격 연결이 설정되지 않았거나 읽을 수 없습니다.')];
  const labels={machine:'머신',agents:'에이전트',agy:'AGY 한도'};
  const confirm=remote?.confirmation;
  if(confirm && typeof confirm==='object') {
    const host=hosts.find(h=>h.id===confirm.id && Array.isArray(h.operations) && h.operations.includes(confirm.operation) && Object.hasOwn(labels,confirm.operation));
    if(!host)return [item('remote-cancel','취소','누르기','연결 확인 취소','idle','remote:cancel')];
    return [
      item('remote-target',clean(host.label,40)||'원격',labels[confirm.operation], `${clean(host.label,40)} · ${labels[confirm.operation]} 조회를 위해 SSH로 연결합니다.`,'blocked'),
      confirm.reviewed===true ? item('remote-confirm','연결 실행',labels[confirm.operation], `${clean(host.label,40)} · ${labels[confirm.operation]} 조회를 확인합니다.`,'blocked',`remote:confirm:${host.id}:${confirm.operation}`) : placeholder('remote-web-review','앱 검토 필요','앱에서 전체 호스트 주소와 포트를 확인하세요.'),
      item('remote-cancel','취소','누르기','연결 확인 취소','idle','remote:cancel'),
    ];
  }
  const observed=Array.isArray(remote?.observations)?remote.observations:[];
  const items=[];
  for(const host of hosts){
    const name=clean(host.label,40)||'원격';
    for(const op of Array.isArray(host.operations)?host.operations:[]){
      if(!Object.hasOwn(labels,op))continue;
      const record=observed.find(x=>x&&x.id===host.id&&x.operation===op);
      let caption=labels[op],detail=`${name} · ${labels[op]} 조회. 선택 후 한 번 더 확인합니다.`;
      let state='idle';
      if(record&&['ok','stale'].includes(record.status)){
        state=record.status==='stale'?'unknown':'idle';
        const old=record.status==='stale'?'오래됨 · ':'';
        const stamp=clean(record.observedAt,35);
        if(op==='machine'){
          const load=finite(record.data?.load1,0,1e6);
          caption=load===null?'머신 확인':`부하 ${load.toFixed(1)}`;
          detail=`${old}${labels[op]}${stamp?` · ${stamp}`:''}`;
        } else if(op==='agents'){
          const count=finite(record.data?.states?.working,0,5000);
          caption=count===null?'상태 미확인':`작업 ${Math.round(count)}`;
          detail=`${old}${labels[op]}${stamp?` · ${stamp}`:''}`;
        } else {
          caption=record.status==='stale'?'한도 오래됨':'한도 확인됨';
          detail=`${old}${labels[op]}${stamp?` · ${stamp}`:''}`;
        }
      }
      items.push(item(`remote-${host.id}-${op}`,name,labels[op],`${name} · ${labels[op]} 조회. 선택 후 한 번 더 확인합니다.`,'idle',`remote:prepare:${host.id}:${op}`));
      if(record&&['ok','stale'].includes(record.status))items.push(item(`remote-${host.id}-${op}-result`,labels[op],caption,detail,state));
      if(op==='agy'&&record&&['ok','stale'].includes(record.status)){
        const windows=Array.isArray(record.data?.windows)?record.data.windows.slice(0,10):[];
        for(const [i,window] of windows.entries()){
          const used=finite(window?.usedPercent,0,100);
          const label=clean(window?.label,40)||name;
          const period=window?.window==='weekly'?'7일':window?.window==='5h'?'5시간':'한도';
          const reset=typeof window?.resetsAt==='string'&&Number.isFinite(Date.parse(window.resetsAt))?window.resetsAt:'리셋 미확인';
          items.push(item(`remote-${host.id}-agy-${i}`,label,used===null?'미확인':`${Math.round(used)}% 사용`,`${period} · ${record.status==='stale'?'오래됨 · ':''}${reset}`,record.status==='stale'||used===null?'unknown':'idle'));
        }
      }
    }
  }
  return items.length?items:[placeholder('remote-no-operations','원격 설정','허용된 조회가 없습니다.')];
}
function creditItems(credits) {
  const services=Array.isArray(credits?.services)?credits.services:[];
  if(!services.length)return [placeholder('credits-unavailable','크레딧','연결된 잔액 정보가 없습니다.')];
  return services.slice(0,20).map((service,index)=>{
    const value=finite(service?.balance,0,1e15),name=clean(service?.label,40)||'크레딧';
    const state=['ok','stale'].includes(service?.status)?service.status:service?.status==='not-configured'?'not-configured':'unavailable';
    const caption=state==='not-configured'?'설정 필요':value===null?'미확인':new Intl.NumberFormat('ko-KR',{maximumFractionDigits:2}).format(value);
    const reset=clean(service?.resetAt,80)||clean(service?.resetLabel,80);
    const detail=[state==='stale'?'오래된 값':'',clean(service?.checkedAt,40)?`관측 ${clean(service.checkedAt,40)}`:'',reset?`리셋 ${reset}`:'',service?.resetQuality==='source-estimate'?'리셋 추정':''].filter(Boolean).join(' · ');
    const id=clean(service?.id,50)||String(index);
    return item(`credit-${id}`,name,caption,detail,state==='ok'?'idle':'unknown');
  });
}

// User shortcuts (#33). Labels and captions are the user's own words and are
// never translated; only the built-in system keys (ids scb-*) are.
const SHORTCUT_CAPTION={app:'앱 열기',url:'링크',text:'문구',command:'길게'};
function shortcutItems(config) {
  const list=Array.isArray(config?.items)?config.items:[];
  const items=list.filter(sc=>sc&&typeof sc.id==='string').map(sc=>{
    const caption=clean(sc.caption,24)||(sc.type==='system'?'':SHORTCUT_CAPTION[sc.type]||'');
    const detail=sc.type==='app'?`앱 열기: ${clean(sc.app,60)}`
      :sc.type==='url'?`링크 열기: ${clean(sc.url,60)}`
      :sc.type==='text'?`${sc.submit?'붙여넣고 입력':'붙여넣기'}: ${clean(sc.text,50)}`
      :sc.type==='command'?`길게 눌러 실행: ${clean(Array.isArray(sc.command)?sc.command.join(' '):'',50)}`
      :clean(sc.label,40);
    return item(sc.id,clean(sc.label,40)||'바로가기',caption,detail,sc.type==='command'?'blocked':'idle',`shortcut:${sc.id}`);
  });
  if(config?.status==='unavailable')items.push(item('shortcuts-unavailable','설정 파일 확인','미확인','shortcuts.json을 읽지 못했습니다. 본인만 고칠 수 있는 JSON 파일인지 확인하세요.','unknown'));
  else if(config?.status==='unconfigured')items.push(item('shortcuts-setup','바로가기 설정','설정 필요','~/.config/streamdock-ai/shortcuts.json에 항목을 적으면 여기에 나타납니다. 예제는 examples/shortcuts.example.json입니다.','unknown'));
  if(Number.isSafeInteger(config?.skipped)&&config.skipped>0)items.push(item('shortcuts-skipped','건너뜀',`${config.skipped}개`,'형식이 맞지 않는 항목은 건너뛰었습니다.','unknown'));
  return items;
}

/** Produce 293S feature keys. Unknown modes and missing sources are explicit. */
export function featureItems(mode, {machine,pomodoro,market,parcels,worktrees,usage,agents,remote,credits,settings,cleanup,shortcuts}={}) {
  switch(mode){
    case 'summary':return summaryItems({agents,usage});
    case 'machines':return machineItems(machine,cleanup);
    case 'pomodoro':return timerItems(pomodoro);
    case 'shortcuts':return shortcutItems(shortcuts);
    case 'market':return marketItems(market);
    case 'parcels':return parcelItems(parcels);
    case 'worktrees':return worktreeItems(worktrees);
    case 'games':return [['mole','두더지'],['simon','기억 게임'],['pairs','짝 맞추기'],['slot','슬롯'],['bj','블랙잭'],['poker','포커'],['race','레이스']].map(([id,label])=>item(`game-${id}`,label,'시작','기기에서 미니게임 시작','idle',`game:${id}`));
    case 'scenes':return [['aquarium','수족관'],['fire','벽난로'],['rain','비'],['beach','해변']].map(([id,label])=>item(`scene-${id}`,label,'보기','기기 화면 전환','idle',`scene:${id}`));
    case 'credits':return creditItems(credits);
    case 'remote':return remoteItems(remote);
    case 'settings': {
      const soundKnown=typeof settings?.sound?.enabled==='boolean';
      const soundEnabled=settings?.sound?.enabled===true;
      const items=[['ko','en'].includes(settings?.language)
        ? item('settings-language','언어',settings.language==='ko'?'한국어':'English','누르면 기기 언어를 변경합니다.','idle','settings:language')
        : placeholder('settings-language','언어','설정값을 확인할 수 없습니다.'),
        soundKnown
        ? item('settings-sound','효과음',soundEnabled?'켜짐':'꺼짐',soundEnabled?'누르면 효과음을 끕니다.':'누르면 효과음을 켭니다.','idle','settings:sound')
        : placeholder('settings-sound','효과음','설정값을 확인할 수 없습니다.')];
      items.push(item('settings-keytest','키 시험','번호 확인','키마다 위치 번호·행/열·기기 슬롯을 그리고 누른 키를 표시합니다. 오른쪽 아래 키를 길게 누르면 나갑니다.','idle','settings:keytest'));
      const screen=settings?.screensaver;
      if(!screen || typeof screen.enabled!=='boolean') {
        items.push(placeholder('settings-screen','화면보호','설정값을 확인할 수 없습니다.'));
      } else {
        items.push(item('settings-screen','화면보호',screen.enabled?'켜짐':'꺼짐',screen.enabled?'누르면 화면보호기를 끕니다.':'누르면 화면보호기를 켭니다.','idle','settings:screen:toggle'));
        for(const minutes of [1,5,15])items.push(item(`settings-idle-${minutes}`,`대기 ${minutes}분`,screen.idleMinutes===minutes?'선택됨':'설정',`화면보호 시작 대기를 ${minutes}분으로 설정합니다.`,'idle',`settings:screen:idle:${minutes}`));
        for(const [id,label] of [['aquarium','수족관'],['fire','벽난로'],['rain','비'],['beach','해변']])items.push(item(`settings-scene-${id}`,label,screen.scene===id?'선택됨':'설정','화면보호 장면을 선택합니다.','idle',`settings:screen:scene:${id}`));
      }
      const brightness=finite(settings?.brightness,0,100);
      items.push(item('settings-brightness','밝기 설정',brightness===null?'미확인':`${Math.round(brightness)}% 저장`,brightness===null?'저장된 밝기 설정이 없습니다.':'이 값은 저장된 설정이며 실제 장치 밝기는 확인하지 못했습니다.',brightness===null?'unknown':'idle'));
      if(settings?.capabilities?.brightness===true) {
        for(const level of [20,50,80,100])items.push(item(`settings-brightness-${level}`,`밝기 ${level}`,brightness===level?'선택됨':'설정',`장치 밝기를 ${level}%로 설정합니다.`,'idle',`settings:brightness:${level}`));
      }
      const update=settings?.update;
      if(!update || update.configured!==true)items.push(placeholder('settings-update','업데이트','신뢰할 저장소와 브랜치를 설정해야 합니다.'));
      else {
        const labels={local_only:'로컬 확인',up_to_date:'최신',update_available:'업데이트 있음',unavailable:'확인 불가',not_configured:'설정 필요'};
        const status=labels[update.status]||'확인 필요';
        const detail=clean(update.message,160)||'업데이트 상태입니다. 설치와 재시작은 별도입니다.';
        items.push(item('settings-update','업데이트',status,detail,update.status==='unavailable'?'unknown':'idle'));
        if(update.canCheck===true)items.push(item('settings-update-check','업데이트','원격 확인','누르면 설정한 저장소의 원격 상태를 확인합니다.','idle','update:check'));
        if(update.status==='update_available'&&update.canPrepare===true)items.push(item('settings-update-prepare','변경 내용','검토 준비','누르면 변경 내용을 가져와 앱 검토를 준비합니다. 적용은 별도입니다.','idle','update:prepare'));
      }
      return items;
    }
    default:return [placeholder('feature-unavailable','기능','지원하지 않는 기능입니다.')];
  }
}
