import { promises as fs, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const run=promisify(execFile), MAX_FILE=256_000, MAX_TABS=8, MAX_ROWS=40;
const clean=(s,max=80)=>typeof s==='string'?Array.from(s.replace(/[\p{Cc}\p{Cf}]/gu,' ').trim()).slice(0,max).join(''):'';
const tracking=s=>{const v=typeof s==='string'?s.replace(/\s/g,'').toUpperCase():'';return /^[A-Z0-9-]{8,30}$/.test(v)?v:null};
const escapeRegex=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const validPort=p=>Number.isInteger(p)&&p>=1024&&p<=65535;
const TRACKING_PATH='/p/tracking/index.html';
const validUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&['www.aliexpress.com','aliexpress.com'].includes(u.hostname)&&(!u.port||u.port==='443')&&!u.username&&!u.password&&u.pathname===TRACKING_PATH;}catch{return false;}};

// This fixed expression does not click, navigate, use network, inspect cookies,
// or return page text. Only explicitly labelled tracking numbers are returned.
const EXPRESSION=`(() => {
  try {
    const url = new URL(location.href);
    if(url.protocol !== 'https:' || !['www.aliexpress.com','aliexpress.com'].includes(url.hostname) || (url.port && url.port !== '443') || url.username || url.password || url.pathname !== '/p/tracking/index.html') return {valid:false,entries:[]};
    const body=(document.body?.innerText || '').slice(0,30000);
    const pattern=/(?:운송장\\s*번호|추적\\s*번호|송장\\s*번호|Tracking\\s*(?:number|No\\.?))\\s*[:：]?\\s*([A-Z0-9-]{8,30})(?![A-Z0-9-])/gi;
    const values=[...body.matchAll(pattern)].slice(0,40).map(m=>({tracking:m[1],title:'AliExpress'}));
    return {valid:true,entries:values};
  } catch { return {valid:false,entries:[]}; }
})()`;

async function safeRead(file,max=MAX_FILE){
  let h;try{h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const s=await h.stat();if(!s.isFile()||s.size>max)throw Error('Invalid file');const bytes=await h.readFile();if(bytes.length>max)throw Error('Invalid file');return {bytes,stat:s};}
  catch(e){if(e.code==='ENOENT')return null;throw e;}finally{await h?.close().catch(()=>{});}
}
async function tabList(port){
  const r=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(3000),redirect:'error'});if(!r.ok)throw Error('Unavailable');
  const n=Number(r.headers.get('content-length'));if(Number.isFinite(n)&&n>1_000_000)throw Error('Oversize');
  const reader=r.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1_000_000){await reader.cancel();throw Error('Oversize');}chunks.push(value);}}finally{reader.releaseLock();}
  const data=JSON.parse(Buffer.concat(chunks.map(v=>Buffer.from(v))).toString('utf8'));if(!Array.isArray(data))throw Error('Invalid');return data;
}
async function evaluate(port,id){
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw Error('Invalid tab');
  return new Promise((resolve,reject)=>{let settled=false;const ws=new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${id}`);const timer=setTimeout(()=>finish(Error('Timeout')),4000);
    function finish(err,val){if(settled)return;settled=true;clearTimeout(timer);try{ws.close()}catch{}err?reject(err):resolve(val)}
    ws.addEventListener('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:EXPRESSION,returnByValue:true,silent:true}})));
    ws.addEventListener('error',()=>finish(Error('Unavailable')));
    ws.addEventListener('message',event=>{if(typeof event.data!=='string'||event.data.length>32000)return finish(Error('Invalid response'));try{const x=JSON.parse(event.data);if(x.id!==1)return;if(x.error||x.result?.exceptionDetails)return finish(Error('Evaluation failed'));finish(null,x.result?.result?.value??null)}catch{finish(Error('Invalid response'))}});
  });
}
/** A loopback listener must be the same-UID Chrome with our dedicated profile. */
export async function verifyParcelChrome({port,home=os.homedir(),execute=run,resolve=fs.realpath,uid=process.getuid?.()}={}){
  if(!validPort(port))return null;
  try{
    const expected=await resolve(path.join(home,'.cache','streamdock-ai','parcel-browser'));
    const listener=await execute('/usr/sbin/lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-Fpn'],{timeout:2500,maxBuffer:8192});
    const lines=String(listener.stdout||'').trim().split(/\r?\n/),ids=[...new Set(lines.filter(x=>/^p\d+$/.test(x)).map(x=>x.slice(1)))],addresses=lines.filter(x=>x.startsWith('n')).map(x=>x.slice(1));
    if(ids.length!==1||!addresses.length||addresses.some(x=>x!==`127.0.0.1:${port}`&&x!==`[::1]:${port}`))return null;
    const pid=ids[0],info=await execute('/bin/ps',['-p',pid,'-o','uid=,lstart=,comm='],{timeout:2000,maxBuffer:8192});
    const m=/^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+?)\s*$/s.exec(String(info.stdout||''));
    if(!m||Number(m[1])!==uid)return null;
    const allowed=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'];
    const exe=await resolve(m[3]);let valid=false;for(const candidate of allowed){try{if(exe===await resolve(candidate))valid=true}catch{}}
    if(!valid)return null;
    const args=String((await execute('/bin/ps',['-p',pid,'-o','args='],{timeout:2000,maxBuffer:65536})).stdout||'');
    const profile=new RegExp(`(?:^|\\s)--user-data-dir(?:=|\\s+)["']?${escapeRegex(expected)}["']?(?=\\s|$)`),portFlag=new RegExp(`(?:^|\\s)--remote-debugging-port(?:=|\\s+)${port}(?=\\s|$)`);
    if(!profile.test(args)||!portFlag.test(args))return null;
    return {pid,start:m[2]};
  }catch{return null;}
}
function parseSettings(record){if(!record)return null;let data;try{data=JSON.parse(record.bytes.toString('utf8'))}catch{return null;}if(!data||data.enabled!==true||data.source!=='cdp'||data.dedicatedProfile!==true||!validPort(data.port))return null;return {port:data.port};}
function parseDestination(record){if(!record)return {trackingOptIn:false,parcels:[]};const v=JSON.parse(record.bytes.toString('utf8'));if(!v||typeof v!=='object'||Array.isArray(v)||!Array.isArray(v.parcels)||v.parcels.length>50)throw Error('Invalid destination');return v;}
const hash=record=>record?createHash('sha256').update(record.bytes).digest('hex'):'missing';

/** All browser reads and file writes require separate explicit caller actions. */
export function createParcelImport({home=os.homedir(),settingsPath=path.join(home,'.config','streamdock-ai','parcel-import.json'),destinationPath=path.join(home,'.config','streamdock-ai','parcels.json'),verify=verifyParcelChrome,listTabs=tabList,readTab=evaluate,now=Date.now,token=()=>randomBytes(24).toString('hex')}={}){
  const key=randomBytes(32);let proposal=null,busy=false,generation=0;
  const idFor=s=>createHmac('sha256',key).update(s).digest('hex').slice(0,20);
  return {
    async availability(){try{return {importAvailable:!!parseSettings(await safeRead(settingsPath,32000))};}catch{return {importAvailable:false};}},
    async preview({consent=false}={}){
      if(busy)return {ok:false,code:'busy'};if(consent!==true)return {ok:false,code:'consent_required'};
      busy=true;proposal=null;const gen=++generation;
      try{
        const settingsRecord=await safeRead(settingsPath,32000),settings=parseSettings(settingsRecord);if(!settings)return {ok:false,code:'not_configured'};
        const before=await verify({port:settings.port,home});if(!before||typeof before.pid!=='string'||typeof before.start!=='string')return {ok:false,code:'browser_unverified'};
        const tabs=await listTabs(settings.port);if(!Array.isArray(tabs))return {ok:false,code:'unavailable'};
        const selected=tabs.filter(t=>t?.type==='page'&&typeof t.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(t.id)&&validUrl(t.url));
        if(selected.length>MAX_TABS)return {ok:false,code:'too_many_tabs'};if(!selected.length)return {ok:false,code:'no_tracking_tabs'};
        const rows=[];
        for(const tab of selected){
          const check=await verify({port:settings.port,home});if(!check||check.pid!==before.pid||check.start!==before.start)return {ok:false,code:'browser_changed'};
          const result=await readTab(settings.port,tab.id);if(!result||result.valid!==true||!Array.isArray(result.entries)||result.entries.length>MAX_ROWS)return {ok:false,code:'page_changed'};
          for(const entry of result.entries){const code=tracking(entry?.tracking);if(!code)continue;rows.push({id:idFor(code),tracking:code,title:clean(entry.title)||'AliExpress'});if(rows.length>MAX_ROWS)return {ok:false,code:'too_many_entries'};}
        }
        const after=await verify({port:settings.port,home});if(!after||after.pid!==before.pid||after.start!==before.start||gen!==generation)return {ok:false,code:'browser_changed'};
        const unique=[...new Map(rows.map(x=>[x.tracking,x])).values()];if(!unique.length)return {ok:false,code:'no_tracking_data'};
        const dest=await safeRead(destinationPath),current=parseDestination(dest),known=new Set(current.parcels.map(p=>tracking(p?.tracking)).filter(Boolean));
        const entries=unique.map(x=>({...x,exists:known.has(x.tracking)}));
        if(entries.filter(x=>!x.exists).length+current.parcels.length>50)return {ok:false,code:'too_many_entries'};
        const value=token();if(typeof value!=='string'||!/^[a-f0-9]{48}$/i.test(value))return {ok:false,code:'unavailable'};
        const createdAt=now(),expiresAt=createdAt+120000;if(!Number.isFinite(createdAt)||expiresAt>8.64e15)return {ok:false,code:'unavailable'};
        if(gen!==generation)return {ok:false,code:'cancelled'};
        proposal={token:value,createdAt,expiresAt,settingsHash:hash(settingsRecord),destinationHash:hash(dest),entries:entries.map(x=>({...x})),gen};
        return {ok:true,stage:'review',token:value,expiresAt:new Date(expiresAt).toISOString(),plan:{source:'AliExpress 열린 배송 탭',count:entries.length,entries:entries.map(x=>({...x}))}};
      }catch{return {ok:false,code:'unavailable'};}finally{busy=false;}
    },
    async apply(value,selectedIds){
      if(busy)return {ok:false,code:'busy'};if(!proposal)return {ok:false,code:'expired'};
      const plan=proposal;if(typeof value!=='string'||value!==plan.token)return {ok:false,code:'invalid_confirmation'};
      if(!Array.isArray(selectedIds)||!selectedIds.length||selectedIds.length>MAX_ROWS||new Set(selectedIds).size!==selectedIds.length||selectedIds.some(id=>typeof id!=='string'||!plan.entries.some(e=>e.id===id)))return {ok:false,code:'invalid_selection'};
      proposal=null;const gen=++generation;busy=true;
      try{
        const currentTime=now();if(currentTime<plan.createdAt||currentTime>=plan.expiresAt)return {ok:false,code:'expired'};
        const [settings,dest]=await Promise.all([safeRead(settingsPath,32000),safeRead(destinationPath)]);
        if(hash(settings)!==plan.settingsHash||!parseSettings(settings)||hash(dest)!==plan.destinationHash)return {ok:false,code:'changed'};
        const current=parseDestination(dest),known=new Set(current.parcels.map(p=>tracking(p?.tracking)).filter(Boolean));
        const incoming=plan.entries.filter(x=>selectedIds.includes(x.id)&&!known.has(x.tracking));if(!incoming.length)return {ok:true,code:'no_new',added:0};
        if(current.parcels.length+incoming.length>50)return {ok:false,code:'too_many_entries'};
        const next={...current,parcels:[...current.parcels,...incoming.map(x=>({tracking:x.tracking,title:x.title}))]};
        const output=JSON.stringify(next,null,2)+'\n';if(Buffer.byteLength(output)>MAX_FILE)return {ok:false,code:'too_many_entries'};
        const dir=path.dirname(destinationPath);await fs.mkdir(dir,{recursive:true,mode:0o700});
        // Refuse a symlinked destination directory; no browser profile writes.
        if(!(await fs.lstat(dir)).isDirectory()||await fs.realpath(dir)!==path.resolve(dir))return {ok:false,code:'unsafe_path'};
        const temp=path.join(dir,`.parcel-import-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);let h;
        try{
          h=await fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);await h.writeFile(output);await h.sync();await h.close();h=null;
          const [latest,latestSettings]=await Promise.all([safeRead(destinationPath),safeRead(settingsPath,32000)]);
          if(gen!==generation||hash(latest)!==plan.destinationHash||hash(latestSettings)!==plan.settingsHash||!parseSettings(latestSettings)||now()<plan.createdAt||now()>=plan.expiresAt)return {ok:false,code:'changed'};
          if(!dest){try{await fs.link(temp,destinationPath);}catch(e){if(e.code==='EEXIST')return {ok:false,code:'changed'};throw e;}}
          else await fs.rename(temp,destinationPath);
          return {ok:true,code:'imported',added:incoming.length};
        }finally{await h?.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}
      }catch{return {ok:false,code:'unavailable'};}finally{busy=false;}
    },
    cancel(){generation++;proposal=null;},
  };
}
