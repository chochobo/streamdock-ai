import { promises as fs, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Static scripts only: user-controlled labels and SSH targets are never interpolated.
const MACHINE_SCRIPT = String.raw`import json, os, shutil
result={"load1":None,"cpuCount":None,"diskUsedPercent":None}
try:
 v=os.getloadavg()[0]
 if v>=0: result["load1"]=v
except (OSError,AttributeError): pass
n=os.cpu_count()
if isinstance(n,int) and n>0: result["cpuCount"]=n
try:
 d=shutil.disk_usage("/")
 if d.total>0: result["diskUsedPercent"]=100*(d.total-d.free)/d.total
except OSError: pass
print(json.dumps(result))
`;
const AGENTS_SCRIPT = String.raw`import json, os, subprocess, sys
try:
 env=dict(os.environ,PATH=os.path.expanduser("~/.local/bin")+":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
 r=subprocess.run(["herdr-core","ls","--json"],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=12,check=True,env=env)
 if len(r.stdout)>500000: sys.exit(1)
 value=json.loads(r.stdout)
 terms=value.get("terminals") if isinstance(value,dict) else None
 if not isinstance(terms,list) or len(terms)>5000: sys.exit(1)
 states={s:0 for s in ("working","blocked","done","idle","error","unknown")}
 providers={s:0 for s in ("codex","claude","antigravity")}
 total=0
 for row in terms:
  if not isinstance(row,dict) or row.get("parent") or row.get("name"): continue
  provider={"claude-code":"claude","codex":"codex","antigravity":"antigravity"}.get(row.get("agent"))
  if not provider: continue
  total+=1
  providers[provider]+=1
  state=row.get("status")
  states[state if state in states else "unknown"]+=1
 print(json.dumps({"total":total,"states":states,"providers":providers}))
except (OSError,ValueError,TypeError,subprocess.SubprocessError): sys.exit(1)
`;
const AGY_SCRIPT = String.raw`import json,math,os,re,subprocess,sys
try:
 env=dict(os.environ,PATH=os.path.expanduser("~/.local/bin")+":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
 v=subprocess.run(["agy","--version"],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=8,check=True,env=env,text=True)
 m=re.search(r"(?<![\d.])v?(\d+)\.(\d+)\.(\d+)(?![-\w.])",v.stdout)
 if not m or tuple(map(int,m.groups()))<(1,1,11): sys.exit(1)
 r=subprocess.run(["agy","-p","/usage","--output-format","json"],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=30,check=True,env=env)
 if len(r.stdout)>500000: sys.exit(1)
 value=json.loads(r.stdout)
 if not isinstance(value,dict) or value.get("status")!="SUCCESS" or "error" in value: sys.exit(1)
 command=value.get("command")
 data=command.get("data") if isinstance(command,dict) else None
 groups=data.get("groups") if isinstance(data,dict) else None
 if not isinstance(groups,list): sys.exit(1)
 safe=[]
 for group in groups[:50]:
  if not isinstance(group,dict) or group.get("disabled") is True or group.get("enabled") is False: continue
  name=group.get("name"); buckets=group.get("buckets")
  if not isinstance(name,str) or not name.strip() or len(name)>80 or not isinstance(buckets,list): continue
  cleaned=[]
  for bucket in buckets[:20]:
   if not isinstance(bucket,dict) or bucket.get("disabled") is True or bucket.get("enabled") is False: continue
   remaining=bucket.get("remaining_fraction");window=bucket.get("window");reset=bucket.get("reset_time")
   if isinstance(remaining,bool) or not isinstance(remaining,(int,float)) or not math.isfinite(remaining) or not 0<=remaining<=1 or window not in ("5h","weekly"): continue
   if reset is not None and (not isinstance(reset,str) or len(reset)>80): continue
   cleaned.append({"window":window,"remaining_fraction":remaining,"reset_time":reset})
  if cleaned:safe.append({"name":name,"buckets":cleaned})
 print(json.dumps({"status":"SUCCESS","command":{"data":{"groups":safe}}}))
except (OSError,ValueError,TypeError,subprocess.SubprocessError): sys.exit(1)
`;
const SCRIPTS={machine:MACHINE_SCRIPT,agents:AGENTS_SCRIPT,agy:AGY_SCRIPT};
const MAX_CONFIG=64_000,MAX_OUTPUT=500_000,MAX_HOSTS=8;
const HOST=/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;
const text=(s,max=50)=>typeof s==='string'?Array.from(s.replace(/[\p{Cc}\p{Cf}]/gu,' ').trim()).slice(0,max).join(''):'';
const number=(x,min,max)=>typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max?x:null;
const unavailable=(operation,label)=>({status:'unavailable',operation,label,source:'ssh',observedAt:null,data:null});

function executeSsh(args,{input,timeoutMs}) {
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/ssh',args,{shell:false,stdio:['pipe','pipe','ignore'],windowsHide:true});
    const chunks=[];let count=0,done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(new Error('Remote request timed out'));},timeoutMs);
    child.on('error',()=>finish(new Error('Remote request failed')));
    child.stdout.on('data',buf=>{count+=buf.length;if(count>MAX_OUTPUT){child.kill('SIGTERM');finish(new Error('Remote response too large'));}else chunks.push(buf);});
    child.on('close',code=>code===0?finish(null,Buffer.concat(chunks).toString('utf8')):finish(new Error('Remote request failed')));
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
function parseMachine(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const load1=number(value.load1,0,1e6),cpuCount=number(value.cpuCount,1,65536),diskUsedPercent=number(value.diskUsedPercent,0,100);
  return load1===null&&cpuCount===null&&diskUsedPercent===null?null:{load1,cpuCount,diskUsedPercent};
}
function parseAgents(value) {
  if(!value||typeof value!=='object'||!Number.isSafeInteger(value.total)||value.total<0||value.total>5000)return null;
  const stateKeys=['working','blocked','done','idle','error','unknown'],providerKeys=['codex','claude','antigravity'];
  const states={},providers={};
  for(const key of stateKeys){const n=value.states?.[key];if(!Number.isSafeInteger(n)||n<0||n>5000)return null;states[key]=n;}
  for(const key of providerKeys){const n=value.providers?.[key];if(!Number.isSafeInteger(n)||n<0||n>5000)return null;providers[key]=n;}
  if(Object.values(states).reduce((a,b)=>a+b,0)!==value.total||Object.values(providers).reduce((a,b)=>a+b,0)!==value.total)return null;
  return {total:value.total,states,providers};
}
function parseAgy(value) {
  if(!value||value.status!=='SUCCESS'||Object.hasOwn(value,'error')||!Array.isArray(value.command?.data?.groups))return null;
  const windows=[];
  for(const group of value.command.data.groups.slice(0,50)){
    if(!group||typeof group!=='object'||group.disabled===true||group.enabled===false||typeof group.name!=='string'||!Array.isArray(group.buckets))continue;
    const label=text(group.name,40);if(!label)continue;
    for(const bucket of group.buckets.slice(0,20)){
      if(!bucket||bucket.disabled===true||bucket.enabled===false||!['5h','weekly'].includes(bucket.window))continue;
      const remaining=number(bucket.remaining_fraction,0,1);if(remaining===null)continue;
      let resetsAt=null;
      if(bucket.reset_time!=null){
        if(typeof bucket.reset_time!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/i.test(bucket.reset_time))continue;
        const t=Date.parse(bucket.reset_time);if(!Number.isFinite(t))continue;resetsAt=new Date(t).toISOString();
      }
      windows.push({label,window:bucket.window,usedPercent:(1-remaining)*100,resetsAt});
    }
  }
  return windows.length?{windows}:null;
}

/** Configuration is local and explicit. read() never connects. refresh() needs
 * both an enabled operation and consent:true. Credentials remain with SSH. */
export function createRemoteProvider({home=os.homedir(),file=path.join(home,'.config','streamdock-ai','remote.json'),run=executeSsh,now=Date.now,timeoutMs=45000,maxStaleMs=900000,reviewMs=120000,token=()=>randomBytes(24).toString('hex')}={}) {
  const secret=randomBytes(32),cache=new Map(),pending=new Map();
  let active=0,review=null,preparing=false,confirming=false,generation=0;
  const deadline=Number.isFinite(timeoutMs)?Math.max(1000,Math.min(timeoutMs,45000)):45000;
  const reviewDeadline=Number.isFinite(reviewMs)?Math.max(1000,Math.min(reviewMs,120000)):120000;
  const idFor=h=>createHmac('sha256',secret).update(`${h.ssh}\0${h.port}\0${h.label}`).digest('hex').slice(0,20);
  const fingerprint=(h,op)=>createHmac('sha256',secret).update(JSON.stringify([h.ssh,h.port,h.label,h.operations,op])).digest('hex');
  async function load(){
    let handle;
    try {
      handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_CONFIG)throw new Error('Invalid remote configuration');
      const raw=await handle.readFile('utf8');if(Buffer.byteLength(raw)>MAX_CONFIG)throw new Error('Invalid remote configuration');
      const data=JSON.parse(raw);
      if(!data||typeof data!=='object'||data.enabled!==true)return [];
      if(!Array.isArray(data.hosts)||data.hosts.length>MAX_HOSTS)throw new Error('Invalid remote configuration');
      const out=[],seen=new Set();
      for(const h of data.hosts){
        if(!h||typeof h!=='object'||typeof h.ssh!=='string'||!HOST.test(h.ssh)||h.ssh.includes('..'))throw new Error('Invalid SSH target');
        const port=h.port===undefined?22:h.port;if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid SSH port');
        const label=text(h.label);if(!label||!Array.isArray(h.operations)||h.operations.some(op=>!Object.hasOwn(SCRIPTS,op)))throw new Error('Invalid remote configuration');
        const entry={ssh:h.ssh,port,label,operations:[...new Set(h.operations)]};entry.id=idFor(entry);
        if(seen.has(entry.id))throw new Error('Duplicate host');seen.add(entry.id);out.push(entry);
      }
      return out;
    }catch(error){if(error.code==='ENOENT')return [];throw error;}
    finally {await handle?.close().catch(()=>{});}
  }
  async function execute(host,operation){
    const key=`${host.id}:${operation}`;
    if(pending.has(key))return {ok:false,code:'busy'};
    if(active>=3)return {ok:false,code:'busy'};
    active++;
    const task=(async()=>{
      try {
        const args=['-F','/dev/null','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5','-o','NumberOfPasswordPrompts=0','-o','UpdateHostKeys=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-p',String(host.port),'--',host.ssh,'python3','-'];
        const output=await run(args,{input:SCRIPTS[operation],timeoutMs:deadline});
        if(typeof output!=='string'||Buffer.byteLength(output)>MAX_OUTPUT)throw new Error('Invalid remote response');
        const parsed=JSON.parse(output);const data=operation==='machine'?parseMachine(parsed):operation==='agents'?parseAgents(parsed):parseAgy(parsed);
        if(!data)throw new Error('Invalid remote response');
        const value={status:'ok',id:host.id,operation,label:host.label,source:'ssh',observedAt:new Date(now()).toISOString(),data};
        cache.set(key,{id:host.id,time:now(),value});return value;
      }catch{
        const old=cache.get(key);if(old&&now()>=old.time&&now()-old.time<=maxStaleMs)return {...old.value,status:'stale'};
        return unavailable(operation,host.label);
      }
    })().finally(()=>{active--;pending.delete(key);});pending.set(key,task);return task;
  }
  return {
    async read(){
      try{const hosts=await load();const publicHosts=hosts.map(({id,label,operations})=>({id,label,operations}));const allowed=new Map(hosts.map(h=>[h.id,new Set(h.operations)]));
        const observations=[...cache.values()].filter(v=>allowed.get(v.id)?.has(v.value.operation)).map(v=>({...v.value,status:now()>=v.time&&now()-v.time<=maxStaleMs?'ok':'stale'}));
        return {status:hosts.length?'configured':'unconfigured',hosts:publicHosts,observations};
      }catch{return {status:'unavailable',hosts:[],observations:[]};}
    },
    // Compatibility callers cannot initiate network access without reviewed plan token.
    async refresh({id,operation}={}){
      let hosts;try{hosts=await load();}catch{return unavailable(operation,null);}
      const host=hosts.find(x=>x.id===id);if(!host)return unavailable(operation,null);
      if(!Object.hasOwn(SCRIPTS,operation)||!host.operations.includes(operation))return {status:'disabled',operation,label:host.label,source:'ssh',observedAt:null,data:null};
      return {status:'review_required',operation,label:host.label,source:'ssh',observedAt:null,data:null};
    },
    async prepare({id,operation}={}){
      if(preparing||confirming)return {ok:false,code:'busy'};
      preparing=true;review=null;const requested=++generation;
      try {
        let hosts;try{hosts=await load();}catch{return {ok:false,code:'unavailable'};}
        if(requested!==generation)return {ok:false,code:'cancelled'};
        const host=hosts.find(x=>x.id===id);
        if(!host)return {ok:false,code:'unavailable'};
        if(!Object.hasOwn(SCRIPTS,operation)||!host.operations.includes(operation))return {ok:false,code:'disabled'};
        const value=token();if(typeof value!=='string'||!/^[a-f0-9]{48}$/i.test(value))return {ok:false,code:'unavailable'};
        const createdAt=now(),expiresAt=createdAt+reviewDeadline;
        if(!Number.isFinite(createdAt)||!Number.isFinite(expiresAt)||expiresAt>8.64e15)return {ok:false,code:'unavailable'};
        review={token:value,id:host.id,operation,fingerprint:fingerprint(host,operation),createdAt,expiresAt};
        return {ok:true,stage:'review',token:value,expiresAt:new Date(expiresAt).toISOString(),plan:{
          label:host.label,host:host.ssh,port:host.port,operation,scope:'표시한 호스트와 포트에 읽기 전용 SSH 조회를 보냅니다.',
        }};
      } finally {preparing=false;}
    },
    async confirm(value){
      if(preparing||confirming)return {ok:false,code:'busy'};
      if(!review)return {ok:false,code:'expired'};
      const proposal=review;
      if(typeof value!=='string'||value!==proposal.token)return {ok:false,code:'invalid_confirmation'};
      review=null;const requested=++generation;confirming=true;
      try {
        const current=now();if(!Number.isFinite(current)||current<proposal.createdAt||current>=proposal.expiresAt)return {ok:false,code:'expired'};
        let hosts;try{hosts=await load();}catch{return {ok:false,code:'changed'};}
        if(requested!==generation)return {ok:false,code:'cancelled'};
        const host=hosts.find(x=>x.id===proposal.id);
        if(!host||!host.operations.includes(proposal.operation)||fingerprint(host,proposal.operation)!==proposal.fingerprint)return {ok:false,code:'changed'};
        if(now()<proposal.createdAt||now()>=proposal.expiresAt)return {ok:false,code:'expired'};
        return await execute(host,proposal.operation);
      } finally {confirming=false;}
    },
    cancel(){generation++;review=null;},
  };
}
