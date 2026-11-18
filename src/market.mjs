/** Public market information. Naver mobile endpoints are unofficial and can change.
 * Observed timestamps describe collection; quoteTime is the provider's market time. */
const ORIGIN = 'https://m.stock.naver.com';
const DEFAULT_TTL = 60_000;
const MAX_STALE = 15 * 60_000;
const MAX_BYTES = 1_000_000;
const VIEWS = new Set(['indices', 'top', 'kosdaq', 'movers', 'portfolio', 'sectors', 'macro']);
const MACRO = [
  ['USD/KRW', 'exchange', 'FX_USDKRW'], ['100JPY/KRW', 'exchange', 'FX_JPYKRW'],
  ['EUR/KRW', 'exchange', 'FX_EURKRW'], ['DXY', 'exchange', '.DXY'],
  ['WTI', 'energy', 'CLcv1'], ['Brent', 'energy', 'LCOcv1'],
  ['Gold', 'metals', 'GCcv1'], ['Silver', 'metals', 'SIcv1'],
  ['US 10Y', 'bond', 'US10YT=RR'], ['US 2Y', 'bond', 'US2YT=RR'],
];

const text = (value, max = 80) => typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()).slice(0, max).join('') : '';
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.replaceAll(',', '').trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
function change(row, field = 'fluctuationsRatio') {
  const value = num(row?.[field]);
  if (value === null) return null;
  const direction = String(row?.compareToPreviousPrice?.code ?? row?.fluctuationsType?.code ?? '');
  return ['4','5'].includes(direction) && value > 0 ? -value : value;
}
function stock(row, fallback = '') {
  if (!row || typeof row !== 'object') return null;
  const name = text(row.stockName) || text(fallback);
  const code = text(row.itemCode || fallback, 24);
  const price = num(row.closePrice);
  if (!name || (price === null && change(row) === null)) return null;
  return { kind:'stock', name, code, price, changePercent:change(row), quoteTime:text(row.localTradedAt, 40) || null, marketStatus:text(row.marketStatus, 20) || null };
}
function sector(row) {
  const name = text(row?.name);
  const changePercent = change(row, 'changeRate');
  if (!name || changePercent === null) return null;
  return { kind:'sector', name, code:text(String(row.no ?? ''),24), price:null, changePercent, riseCount:num(row.riseCount), fallCount:num(row.fallCount), quoteTime:null };
}

async function readJson(url, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, { headers:{'User-Agent':'StreamDock-AI/0.1'}, redirect:'error', signal:AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('Market request failed');
  const size = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(size) && size > MAX_BYTES) throw new Error('Market response too large');
  if (!response.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('Market response too large');
    return JSON.parse(body);
  }
  const reader = response.body.getReader();
  const chunks=[]; let length=0;
  try {
    for (;;) { const {done,value}=await reader.read(); if(done)break; length+=value.byteLength; if(length>MAX_BYTES){await reader.cancel();throw new Error('Market response too large');} chunks.push(value); }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks.map(x=>Buffer.from(x))).toString('utf8'));
}

/** `read({view,force})`: top/kosdaq/movers/sectors/portfolio/macro.
 * Optional portfolio symbols and favorite sectors must be explicitly supplied by caller.
 * Never attach authorization or user state to the public market requests. */
export function createMarketProvider({ fetchImpl=globalThis.fetch, now=Date.now, ttlMs=DEFAULT_TTL, maxStaleMs=MAX_STALE, timeoutMs=6000, portfolio=[], favoriteSectors=[] } = {}) {
  const cache=new Map(), inflight=new Map();
  const symbols = Array.isArray(portfolio) ? [...new Set(portfolio.filter(v=>typeof v==='string' && /^[A-Za-z0-9.\-]{1,16}$/.test(v)))].slice(0,10) : [];
  const favorites = Array.isArray(favoriteSectors) ? [...new Set(favoriteSectors.map(v=>text(v,50)).filter(Boolean))].slice(0,10) : [];
  const get = url => readJson(url,fetchImpl,timeoutMs);
  async function load(view) {
    if (view==='indices') {
      const values=await Promise.allSettled(['KOSPI','KOSDAQ'].map(async name=>{
        const row=await get(`${ORIGIN}/api/index/${name}/basic`);
        const quote=stock(row,name);
        return quote ? {...quote,kind:'index',code:name} : null;
      }));
      const quotes=values.filter(v=>v.status==='fulfilled'&&v.value).map(v=>v.value);
      if(!quotes.length)throw new Error('No market data');
      return {configured:true,quotes,partial:quotes.length<2};
    }
    if (view==='portfolio') {
      if (!symbols.length) return {configured:false, quotes:[]};
      const values=await Promise.allSettled(symbols.map(code=>get(`${ORIGIN}/api/stock/${encodeURIComponent(code)}/basic`).then(row=>stock(row,code))));
      const quotes=values.filter(v=>v.status==='fulfilled'&&v.value).map(v=>v.value);
      if (!quotes.length) throw new Error('No market data');
      return {configured:true,quotes,partial:quotes.length<symbols.length};
    }
    if (view==='top'||view==='kosdaq') {
      const market=view==='top'?'KOSPI':'KOSDAQ';
      const row=await get(`${ORIGIN}/api/stocks/marketValue/${market}?page=1&pageSize=16`);
      if (!Array.isArray(row.stocks)) throw new Error('Invalid market data');
      const quotes=row.stocks.filter(x=>x.stockEndType==='stock').map(x=>stock(x)).filter(Boolean).slice(0,10);
      if (!quotes.length) throw new Error('No market data');
      return {configured:true,quotes,marketStatus:text(row.marketStatus,20)||null};
    }
    if (view==='movers'||view==='sectors') {
      if (view==='sectors'&&!favorites.length) return {configured:false,quotes:[]};
      const row=await get(`${ORIGIN}/api/stocks/industry?page=1&pageSize=100`);
      if (!Array.isArray(row.groups)) throw new Error('Invalid market data');
      const data=row.groups.map(sector).filter(Boolean);
      if (!data.length) throw new Error('No market data');
      const quotes=view==='movers' ? [...data].sort((a,b)=>b.changePercent-a.changePercent) : favorites.map(n=>data.find(x=>x.name===n)).filter(Boolean);
      return {configured:true,quotes:view==='movers'?(quotes.length>10?[...quotes.slice(0,5),...quotes.slice(-5)]:quotes):quotes,partial:view==='sectors'&&quotes.length<favorites.length,marketStatus:text(row.marketStatus,20)||null};
    }
    const values=await Promise.allSettled(MACRO.map(async ([name,category,code])=>{
      const url=new URL('/front-api/marketIndex/productDetail',ORIGIN);
      url.searchParams.set('category',category);url.searchParams.set('reutersCode',code);
      const row=(await get(url.href))?.result;
      if (!row||typeof row!=='object')return null;
      const price=num(row.closePrice), changePercent=change(row);
      if(price===null&&changePercent===null)return null;
      return {kind:'macro',name,code,price,changePercent,unit:text(row.unit,20)||null,quoteTime:text(row.localTradedAt,40)||null,marketStatus:text(row.marketStatus,20)||null};
    }));
    const quotes=values.filter(v=>v.status==='fulfilled'&&v.value).map(v=>v.value);
    if (!quotes.length) throw new Error('No market data');
    return {configured:true,quotes,partial:quotes.length<MACRO.length};
  }
  return {
    async read({view='top',force=false}={}) {
      if(!VIEWS.has(view))throw new TypeError('Unsupported market view');
      const current=now(), previous=cache.get(view);
      if(previous&&!force&&current>=previous.time&&current-previous.time<ttlMs)return previous.value;
      if(inflight.has(view))return inflight.get(view);
      const task=(async()=>{
        try {
          const result=await load(view);
          const value={status:result.configured?'ok':'unconfigured',view,source:'Naver Finance (unofficial)',observedAt:new Date(now()).toISOString(),quotes:result.quotes,marketStatus:result.marketStatus||null,partial:!!result.partial};
          cache.set(view,{time:now(),value});return value;
        } catch {
          if(previous&&current>=previous.time&&current-previous.time<=maxStaleMs&&previous.value.status==='ok')return {...previous.value,status:'stale'};
          return {status:'unavailable',view,source:'Naver Finance (unofficial)',observedAt:null,quotes:[],marketStatus:null,partial:false};
        }
      })().finally(()=>inflight.delete(view));
      inflight.set(view,task);return task;
    },
  };
}
