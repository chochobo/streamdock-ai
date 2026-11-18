import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketProvider} from '../src/market.mjs';

const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
test('loads public Korean top quotes, preserves quote time and caches',async()=>{
 let n=0,now=Date.parse('2026-11-09T00:00:00Z');
 const provider=createMarketProvider({now:()=>now,fetchImpl:async url=>{n++;assert.match(url,/m\.stock\.naver\.com\/api\/stocks\/marketValue\/KOSPI/);return json({marketStatus:'CLOSE',stocks:[{stockEndType:'stock',stockName:'예시',itemCode:'000001',closePrice:'1,234',fluctuationsRatio:'2.1',compareToPreviousPrice:{code:'5'},localTradedAt:'2026-11-06 15:30:00'}]});}});
 const a=await provider.read();assert.equal(a.status,'ok');assert.equal(a.quotes[0].price,1234);assert.equal(a.quotes[0].changePercent,-2.1);assert.equal(a.quotes[0].quoteTime,'2026-11-06 15:30:00');assert.equal(a.marketStatus,'CLOSE');
 await provider.read();assert.equal(n,1);now+=61_000;await provider.read();assert.equal(n,2);
});
test('errors preserve bounded stale data without inventing fresh numbers',async()=>{
 let now=1_800_000_000_000,fail=false;const p=createMarketProvider({now:()=>now,ttlMs:100,maxStaleMs:1000,fetchImpl:async()=>{if(fail)throw new Error('private');return json({stocks:[{stockEndType:'stock',stockName:'A',closePrice:'12',fluctuationsRatio:'0'}]})}});
 const good=await p.read();fail=true;now+=101;let stale=await p.read();assert.equal(stale.status,'stale');assert.equal(stale.observedAt,good.observedAt);assert.equal(stale.quotes[0].changePercent,0);now+=1000;let none=await p.read();assert.equal(none.status,'unavailable');assert.deepEqual(none.quotes,[]);assert.ok(!JSON.stringify(none).includes('private'));
});
test('portfolio and favorites require explicit configuration and do not send requests',async()=>{
 let calls=0;const p=createMarketProvider({fetchImpl:async()=>{calls++;throw Error()}});assert.equal((await p.read({view:'portfolio'})).status,'unconfigured');assert.equal((await p.read({view:'sectors'})).status,'unconfigured');assert.equal(calls,0);await assert.rejects(()=>p.read({view:'arbitrary'}),TypeError);
});
test('concurrent same-view reads share one request and malformed rows are rejected',async()=>{
 let calls=0;const p=createMarketProvider({fetchImpl:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return json({stocks:[{stockEndType:'stock',stockName:'A',closePrice:'--',fluctuationsRatio:null}]})}});const [a,b]=await Promise.all([p.read(),p.read()]);assert.equal(calls,1);assert.equal(a.status,'unavailable');assert.equal(b.status,'unavailable');
});
