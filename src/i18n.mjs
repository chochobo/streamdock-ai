// Only translate app-owned text. External names and free-form details remain intact.
const words = Object.freeze({
  '기능':'Features','바로가기':'Shortcuts','대시보드':'Dashboard','앱 열기':'Open app','링크':'Link','문구':'Text','길게':'Hold','볼륨 +':'Vol +','볼륨 −':'Vol −','음소거':'Mute','화면끄기':'Screen off','보호기':'Saver','올리기':'Up','내리기':'Down','전환':'Toggle','절전':'Sleep','바로가기 설정':'Shortcut setup','설정 파일 확인':'Check file','건너뜀':'Skipped','열림':'Open','사용량':'Usage','이전':'Prev','다음':'Next','뒤로':'Back',
  '요약':'Summary','에이전트':'Agents','기록':'History','머신':'Machine','타이머':'Timer',
  '주식':'Market','게임':'Games','장면':'Scenes','워크트리':'Worktrees','택배':'Parcels',
  '크레딧':'Credits','원격':'Remote','설정':'Settings','메모리':'Memory','메모리 사용':'Memory Used','디스크':'Disk',
  '네트워크':'Network','배터리':'Battery','온도':'Temp','건강 점수':'Health',
  '캐시 정리':'Clear cache','산출물 정리':'Clean builds','휴지통':'Trash',
  '남은 시간':'Time left','일시정지':'Pause','계속':'Resume','초기화':'Reset',
  '두더지':'Mole','기억 게임':'Memory','짝 맞추기':'Pairs','슬롯':'Slots',
  '블랙잭':'Blackjack','포커':'Poker','레이스':'Race','수족관':'Aquarium',
  '벽난로':'Fire','비':'Rain','해변':'Beach','효과음':'Sound','화면보호':'Screensaver',
  '밝기 설정':'Brightness','업데이트':'Update','변경 내용':'Changes',
  '시세 갱신':'Refresh','시세':'Quotes','종목 미확인':'No symbols',
  '알리 가져오기':'Import Ali','택배 설정':'Parcel setup','택배 없음':'No parcels','배송 조회':'Track',
  '조회 불가':'Unavailable','워크트리 없음':'No worktrees','원격 조회 불가':'Remote unavailable',
  '원격 설정':'Remote setup','앱 검토 필요':'Review in app','앱 검토':'App review','연결 실행':'Connect',
  '취소':'Cancel','한도 여유':'Quota left','작업':'Working','확인':'Approval',
  '완료':'Done','미확인':'Unknown','대기':'Idle','진행 중':'Running','시작':'Start',
  '누르기':'Press','검토':'Review','보기':'View','켜짐':'On','꺼짐':'Off',
  '선택됨':'Selected','설정 필요':'Setup','로컬 확인':'Local','최신':'Up to date',
  '업데이트 있음':'Update ready','확인 불가':'Unavailable','확인 필요':'Review',
  '원격 확인':'Check remote','검토 준비':'Prepare review','보기 전환':'Next view',
  '열기':'Open','비공식':'Unofficial','종목 전송':'Send symbols','다음 보기':'Next view',
  '전송 대상':'To send','반복 조회':'Repeats','전송 확인':'Confirm send',
  '미리보기':'Preview','도착':'Delivered','배송 출발':'Out for delivery','통관':'Customs',
  '운송 중':'In transit','발송':'Shipped','배송 오류':'Error','사용 중':'Active',
  '변경 있음':'Modified','주 작업':'Main','검토 가능':'Reviewable','정리 가능':'Cleanable',
  '오래됨':'Stale','미병합':'Unmerged','잠김':'Locked','빠름':'Fast','적정':'On track',
  '여유':'Relaxed','한도':'Limit','AGY 한도':'AGY limit','한도 오래됨':'Limit stale',
  '한도 확인됨':'Limit checked','머신 확인':'Machine','상태 미확인':'Unknown',
  '오류':'Error','전송':'Send','언어':'Language','한국어':'Korean',
  '코스피':'KOSPI','코스닥':'KOSDAQ','업종 등락':'Sectors','포트폴리오':'Portfolio',
  '관심 업종':'Favorites','환율·원자재':'FX & goods','실행 불가':'Unavailable',
  '영구 삭제':'Delete','삭제 대상':'Targets','예상 용량':'Est. size','검토 확인':'Review',
  '최종 확인':'Final confirm','한 번 더 확인':'Confirm again','파일 삭제':'Delete files',
  '브랜치 유지':'Keep branch','대상 경로':'Target path','나머지 대상':'More targets',
  '실행 제한':'Restricted','주소 있음':'Has address','주소 없음':'No address','일부 미확인':'Partly unknown','외장 드라이브':'External drive','선택':'Select','효과':'Effect','게임 메뉴':'Game menu','진행':'Next','소스 적용':'Apply source','돌아가기':'Back','번호 전송':'Send numbers','기본 한도':'Primary limit','추가 한도':'Extra limit','키 시험':'Key test','번호 확인':'Check keys'
});

// Keys which can contain names from accounts, quotes, paths, parcels, or hosts
// are never included in this allowlist, even if the name matches a UI word.
const systemLabelId = /^(?:machine-(?:unavailable|drive-status|cpu|memory|disk|network|battery|temp|health)|timer-(?:unavailable|current|start-\d+|pause|resume|reset)|settings-[\w-]+|game-[\w-]+|scene-[\w-]+|market-(?:view|refresh|heat|source|unavailable|empty|consent-(?:info|cancel|frequency|confirm|invalid))|parcels-[\w-]+|parcel-(?:review|wait|confirm|cancel)|update-(?:review|wait|apply|cancel)|worktrees-empty|worktree-(?:review-scope|confirm|web-review|cancel|reason-\d+)|cleanup-(?:clean|purge|trash|review-scope|review-count|review-size|confirm|web-review|cancel|more|reason-\d+)|summary-(?:working|blocked|done|unknown|recommendation)|credits-unavailable|remote-(?:unconfigured|no-operations|cancel|web-review|confirm)|scb-[\w-]+|shortcuts-[\w-]+|feature-unavailable)$/;
const generatedCaptionId = /^(?:machine-|timer-|settings-|game-|scene-|market-(?!quote-)|parcels-|parcel-(?:\d+$|review|wait|confirm|cancel)|update-(?:review|wait|apply|cancel)|worktree-|worktrees-|cleanup-|summary-(?!recommendation$)|credit-|credits-|remote-|scb-|shortcuts-|feature-)/;
const SHORTCUT_GENERATED_CAPTIONS = new Set(['앱 열기', '링크', '문구', '길게']);
const dynamic = text => {
  let m;
  if ((m = /^(\d+)분$/.exec(text))) return `${m[1]} min`;
  if ((m = /^(\d+)일$/.exec(text))) return `${m[1]}d`;
  if ((m = /^(\d+)시간$/.exec(text))) return `${m[1]}h`;
  if ((m = /^대기 (\d+)분$/.exec(text))) return `Idle ${m[1]}m`;
  if ((m = /^밝기 (\d+)$/.exec(text))) return `Light ${m[1]}%`;
  if ((m = /^(\d+)% 저장$/.exec(text))) return `${m[1]}% saved`;
  if ((m = /^여유 (\d+)%$/.exec(text))) return `Free ${m[1]}%`;
  if ((m = /^사용 (\d+)%$/.exec(text))) return `Used ${m[1]}%`;
  if ((m = /^약 (\d+)%$/.exec(text))) return `~${m[1]}%`;
  if ((m = /^사용 약(\d+)%$/.exec(text))) return `Used ~${m[1]}%`;
  if ((m = /^(\d+)% 사용$/.exec(text))) return `${m[1]}% used`;
  if ((m = /^작업 (\d+)(\?)?$/.exec(text))) return `Working ${m[1]}${m[2] || ''}`;
  if ((m = /^부하 ([\d.]+)$/.exec(text))) return `Load ${m[1]}`;
  if ((m = /^(\d+)초$/.exec(text))) return `${m[1]} sec`;
  if ((m = /^(\d+)개 파일$/.exec(text))) return `${m[1]} files`;
  if ((m = /^(\d+)건$/.exec(text))) return `${m[1]} items`;
  if ((m = /^(\d+)개$/.exec(text))) return `${m[1]} items`;
  if ((m = /^대상 (\d+)$/.exec(text))) return `Target ${m[1]}`;
  return text;
};
const translate = value => typeof value === 'string' ? (words[value] ?? dynamic(value)) : value;

/** Translate UI-owned key text. Call on feature items before the router removes their ids. */
export function translateKeys(keys, language) {
  if (!Array.isArray(keys)) return keys;
  if (language !== 'en') return keys;
  return keys.map(key => {
    if (!key || typeof key !== 'object') return key;
    if (key.kind === 'control') return {...key,label:translate(key.label),caption:translate(key.caption)};
    if (key.kind === 'quota' || key.kind === 'quota-reset') {
      const weekday = {월:'Mon',화:'Tue',수:'Wed',목:'Thu',금:'Fri',토:'Sat',일:'Sun'};
      return {...key,windowLabel:translate(key.windowLabel),resetDate:weekday[key.resetDate] || key.resetDate};
    }
    if (key.kind !== 'feature' || typeof key.id !== 'string') return key;
    // A user shortcut keeps its own words; only the captions the app fills in are translated.
    const generatedShortcutCaption=/^sc-/.test(key.id) && SHORTCUT_GENERATED_CAPTIONS.has(key.caption);
    return {...key,label:systemLabelId.test(key.id) ? translate(key.label) : key.label,caption:generatedCaptionId.test(key.id) || generatedShortcutCaption ? translate(key.caption) : key.caption};
  });
}

// Placeholder account labels the usage providers build. Only accounts with these
// system ids are translated; real account names (emails, org names) are never touched.
const accountLabels = Object.freeze({
  'Codex 연결 계정':'Codex account','Codex 이전 확인 (계정 미확인)':'Codex last known (account unknown)',
  'Claude 계정 미확인':'Claude (account unknown)','Claude Code · 계정 미확인':'Claude Code · account unknown',
  'Claude · AgentDeck · 계정 미확인':'Claude · AgentDeck · account unknown','Claude Desktop · 계정 미확인':'Claude Desktop · account unknown',
});
const systemAccountId = /^(?:codex-local-account|codex-unavailable|claude-unavailable|claude-statusline|claude-agentdeck|claude-desktop-ax)$/;

const translateAccount = account => account && typeof account === 'object' && typeof account.id === 'string' && systemAccountId.test(account.id) && Object.hasOwn(accountLabels, account.label)
  ? {...account,label:accountLabels[account.label]} : account;

/** Translate app-owned placeholder account labels in a usage snapshot, including its pace summary. */
export function translateUsage(usage, language) {
  if (language !== 'en' || !usage || typeof usage !== 'object' || !Array.isArray(usage.accounts)) return usage;
  const pace = usage.pace && typeof usage.pace === 'object'
    ? {...usage.pace,accounts:Array.isArray(usage.pace.accounts) ? usage.pace.accounts.map(translateAccount) : usage.pace.accounts,recommendation:translateAccount(usage.pace.recommendation)}
    : usage.pace;
  return {...usage,accounts:usage.accounts.map(translateAccount),...(Object.hasOwn(usage,'pace') ? {pace} : {})};
}
