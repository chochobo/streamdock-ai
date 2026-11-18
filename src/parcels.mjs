import { promises as fs, constants } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Explicitly configured parcels only. No account import, automatic tracking,
// credentials, inferred delivery dates, or persistent writes are performed.
const FILE_LIMIT = 256_000;
const INPUT_LIMIT = 50;
const clean = (s, max=100) => typeof s === 'string' ? Array.from(s.replace(/[\p{Cc}\p{Cf}]/gu,' ').trim()).slice(0,max).join('') : '';
const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s) ? s : null;
const timestamp = s => {const t=typeof s==='number'?(s>=1e12?s:s*1000):Date.parse(s);return Number.isFinite(t)&&t>0&&t<=8.64e15?new Date(t).toISOString():null};
const sanitizeTracking = s => {const n=typeof s==='string'?s.replace(/\s/g,'').toUpperCase():'';return /^[A-Z0-9-]{5,60}$/.test(n)?n:null;};
function stage(value) {
  const s=String(value||'').toLowerCase();
  if(/undelivered|not delivered|delivery (?:failed|exception)|배달\s*실패|배송\s*실패|미배달|반송|배송\s*취소/.test(s))return 'exception';
  if(/delivered|배달\s*완료|배송\s*완료/.test(s))return 'delivered';
  if(/out for delivery|배송\s*출발|배달\s*출발/.test(s))return 'out_for_delivery';
  if(/customs|clearance|통관|세관/.test(s))return 'customs';
  if(/transit|depart|flight|항공|출국|운송/.test(s))return 'in_transit';
  if(/accepted|picked up|shipment|dispatch|접수|집하|출고/.test(s))return 'shipped';
  return 'unknown';
}
function fallback() {return {status:'unconfigured',source:'local',observedAt:null,parcels:[],trackingEnabled:false};}
async function getJson(fetchImpl,url,timeoutMs) {
  const r=await fetchImpl(url,{headers:{'User-Agent':'StreamDock-AI/0.1'},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(!r.ok)throw new Error('Tracking unavailable');
  const length=Number(r.headers?.get?.('content-length'));if(Number.isFinite(length)&&length>1_000_000)throw new Error('Response too large');
  if (!r.body?.getReader) {
    const raw=await r.text();if(Buffer.byteLength(raw)>1_000_000)throw new Error('Response too large');
    return JSON.parse(raw);
  }
  const reader=r.body.getReader(), chunks=[];let total=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>1_000_000){await reader.cancel();throw new Error('Response too large');}chunks.push(value);}}
  finally {reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks.map(x=>Buffer.from(x))).toString('utf8'));
}

/** Tracking numbers remain private. `read()` never performs network requests.
 * Explicit `trackingOptIn:true` AND `refresh({consent:true})` are required to
 * send configured tracking numbers to Cainiao. Never invoke on a timer. */
export function createParcelsProvider({home=os.homedir(),file=path.join(home,'.config','streamdock-ai','parcels.json'),fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=10000,reviewMs=120000,token=()=>randomBytes(24).toString('hex')}={}) {
  const key=randomBytes(32); let last=null; let lastFingerprint=''; let pending; let review=null; let preparing=false; let confirming=false; let generation=0;
  const identifier=tracking=>createHmac('sha256',key).update(tracking).digest('hex').slice(0,20);
  const fingerprint=c=>createHmac('sha256',key).update(JSON.stringify({trackingEnabled:c.trackingEnabled,entries:c.entries.map(p=>[p.tracking,p.title])})).digest('hex');
  const deadlineMs=Number.isFinite(reviewMs)?Math.max(1000,Math.min(reviewMs,120000)):120000;
  async function config() {
    let handle;
    try {
      handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      const stat=await handle.stat();
      if(!stat.isFile()||stat.size>FILE_LIMIT)throw new Error('Invalid config');
      const raw=await handle.readFile('utf8');
      if(Buffer.byteLength(raw)>FILE_LIMIT)throw new Error('Invalid config');
      const data=JSON.parse(raw);
      if(!data||typeof data!=='object'||!Array.isArray(data.parcels)||data.parcels.length>INPUT_LIMIT)throw new Error('Invalid config');
      const entries=[];const seen=new Set();
      for(const p of data.parcels){
        if(!p||typeof p!=='object')continue;
        const tracking=sanitizeTracking(p.tracking);if(!tracking||seen.has(tracking))continue;seen.add(tracking);
        entries.push({tracking,id:identifier(tracking),title:clean(p.title,80)||'택배',status:clean(p.status,80)||null,eta:date(p.eta),checkedAt:timestamp(p.checkedAt)});
      }
      return {trackingEnabled:data.trackingOptIn===true,entries};
    }catch(e){if(e.code==='ENOENT')return null;throw e;}
    finally {await handle?.close().catch(()=>{});}
  }
  function local(c) {return {status:'ok',source:'local',observedAt:null,trackingEnabled:c.trackingEnabled,parcels:c.entries.map(p=>({id:p.id,title:p.title,state:stage(p.status),status:p.status,eta:p.eta,checkedAt:p.checkedAt}))};}
  async function execute(c) {
    const currentFingerprint=fingerprint(c);
    try {
      const all=[];
      for(let i=0;i<c.entries.length;i+=10){
        const group=c.entries.slice(i,i+10);
        const url=new URL('https://global.cainiao.com/global/detail.json');url.searchParams.set('mailNos',group.map(p=>p.tracking).join(','));url.searchParams.set('lang','ko-KR');
        const data=await getJson(fetchImpl,url.href,timeoutMs);
        if(!Array.isArray(data?.module))throw new Error('Invalid tracking response');
        const byTracking=new Map(data.module.filter(x=>x&&typeof x==='object'&&typeof x.mailNo==='string').map(x=>[x.mailNo.toUpperCase(),x]));
        for(const p of group){const row=byTracking.get(p.tracking);const details=Array.isArray(row?.detailList)?row.detailList:[];
          const status=clean(row?.statusDesc||row?.latestTrace||details[0]?.standerdDesc||details[0]?.desc,80)||null;
          const eta=date(row?.estimatedDeliveryDate||row?.expectedDeliveryDate||row?.eta);
          all.push({id:p.id,title:p.title,state:stage(status),status,eta,checkedAt:row?new Date(now()).toISOString():null});}
      }
      if(!all.some(p=>p.checkedAt))throw new Error('No tracking data');
      last={status:'ok',source:'cainiao-unofficial',observedAt:new Date(now()).toISOString(),trackingEnabled:true,partial:all.some(p=>!p.checkedAt),parcels:all};
      lastFingerprint=currentFingerprint;return last;
    }catch{return last&&lastFingerprint===currentFingerprint?{...last,status:'stale'}:{...local(c),status:'unavailable'};}
  }
  return {
    async read(){
      try {
        const c=await config();if(!c)return fallback();
        if(last&&c.trackingEnabled&&lastFingerprint===fingerprint(c)) {
          const age=now()-Date.parse(last.observedAt);
          return age>=0&&age<=30*60_000?last:{...last,status:'stale'};
        }
        return local(c);
      }catch{return {status:'unavailable',source:'local',observedAt:null,parcels:[],trackingEnabled:false};}
    },
    // Legacy callers may ask for a refresh, but this method never transmits.
    async refresh(){
      try {const c=await config();return c?{...local(c),status:'consent_required'}:fallback();}
      catch{return {status:'unavailable',source:'local',observedAt:null,parcels:[],trackingEnabled:false};}
    },
    async prepareRefresh(){
      if(pending||preparing||confirming)return {ok:false,code:'busy'};
      preparing=true;review=null;const requested=++generation;
      try {
        let c;try{c=await config();}catch{return {ok:false,code:'unavailable'};}
        if(requested!==generation)return {ok:false,code:'cancelled'};
        if(!c)return {ok:false,code:'unconfigured'};
        if(!c.trackingEnabled)return {ok:false,code:'consent_required'};
        if(!c.entries.length)return {ok:false,code:'empty'};
        const value=token();
        if(typeof value!=='string'||!/^[a-f0-9]{48}$/i.test(value))return {ok:false,code:'unavailable'};
        const createdAt=now(),expiresAt=createdAt+deadlineMs;
        if(!Number.isFinite(createdAt)||!Number.isFinite(expiresAt)||expiresAt>8.64e15)return {ok:false,code:'unavailable'};
        review={token:value,fingerprint:fingerprint(c),createdAt,expiresAt};
        return {ok:true,stage:'review',token:value,expiresAt:new Date(expiresAt).toISOString(),plan:{
          destination:'Cainiao',count:c.entries.length,scope:'표시한 운송장 번호를 Cainiao에 전송합니다.',
          targets:c.entries.map(p=>({id:p.id,title:p.title,tracking:p.tracking})),
        }};
      } finally {preparing=false;}
    },
    async confirmRefresh(value){
      if(pending||preparing||confirming)return {ok:false,code:'busy'};
      if(!review)return {ok:false,code:'expired'};
      const proposal=review;
      if(typeof value!=='string'||value!==proposal.token)return {ok:false,code:'invalid_confirmation'};
      review=null; // Consume before asynchronous work; never replay a confirmation.
      const requested=++generation;
      confirming=true;
      try {
        const when=now();
        if(!Number.isFinite(when)||when<proposal.createdAt||when>=proposal.expiresAt)return {ok:false,code:'expired'};
        let c;try{c=await config();}catch{return {ok:false,code:'changed'};}
        if(requested!==generation)return {ok:false,code:'cancelled'};
        if(!c||!c.trackingEnabled||!c.entries.length||fingerprint(c)!==proposal.fingerprint)return {ok:false,code:'changed'};
        if(now()>=proposal.expiresAt||now()<proposal.createdAt)return {ok:false,code:'expired'};
        pending=execute(c).finally(()=>{pending=undefined;});
        return await pending;
      } finally {confirming=false;}
    },
    cancelRefresh(){generation++;review=null;},
  };
}
