import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { readBrowserCredit, verifyDedicatedChrome } from '../src/credits-browser.mjs';
import { readCredits } from '../src/credits.mjs';

async function fixture(t) { const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'streamdock-credit-browser-'))); t.after(() => rm(home, { recursive: true, force: true })); return home; }

test('browser source requires explicit opt-in and uses only one allowed service tab', async () => {
  const setting = { enabled: true, source: 'cdp', dedicatedProfile: true, port: 9223 };
  let verified = 0, listed = 0, read = 0;
  const dependencies = { home: '/tmp/test', now: 0,
    verify: async () => { verified++; return true; },
    listTabs: async () => { listed++; return [{ type: 'page', id: 'ABC', url: 'https://flow.google.com/' }, { type: 'page', id: 'OTHER', url: 'https://flow.google.com.evil.test/' }]; },
    readTab: async (port, id, expression) => { read++; assert.equal(port, 9223); assert.equal(id, 'ABC'); assert.ok(!/document\.cookie|localStorage|click\s*\(/.test(expression)); return { balance: '1,200', resetLabel: '11월 19일 오후 12:00에 초기화', token: 'SECRET' }; },
  };
  assert.equal(await readBrowserCredit('flow', { ...setting, dedicatedProfile: false }, dependencies), null);
  assert.equal(verified, 0);
  const value = await readBrowserCredit('flow', setting, dependencies);
  assert.equal(value.balance, 1200); assert.equal(value.resetAt, null); assert.equal(value.resetQuality, 'displayed-text');
  assert.ok(!JSON.stringify(value).includes('SECRET')); assert.equal(verified, 3); assert.equal(listed, 1); assert.equal(read, 1);
  assert.equal(await readBrowserCredit('flow', setting, { ...dependencies, listTabs: async () => [{ type:'page', id:'1', url:'https://flow.google.com/' }, { type:'page', id:'2', url:'https://flow.google.com/' }] }), null);
});

test('dedicated browser verification rejects wildcard listener and wrong profile', async t => {
  if (typeof process.getuid !== 'function') return t.skip('UID is unavailable');
  const home = await fixture(t); const profile = path.join(home, '.cache/streamdock-ai/credits-browser'); await mkdir(profile, { recursive: true });
  let address = '127.0.0.1:9223', actualProfile = await realpath(profile);
  const execute = async (cmd, args) => {
    if (cmd.endsWith('/lsof')) return { stdout: `p123\nn${address}\n` };
    if (args.includes('uid=,lstart=,comm=')) return { stdout: `${process.getuid()} Mon Nov 9 03:00:00 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n` };
    return { stdout: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9223 --user-data-dir=${actualProfile}\n` };
  };
  assert.equal(await verifyDedicatedChrome({ port: 9223, home, execute }), true);
  address = '*:9223'; assert.equal(await verifyDedicatedChrome({ port: 9223, home, execute }), false);
  address = '127.0.0.1:9223'; actualProfile = path.join(home, 'Library/Application Support/Google/Chrome');
  assert.equal(await verifyDedicatedChrome({ port: 9223, home, execute }), false);
});

test('configured browser source is bounded to one observation per 30 minutes', async t => {
  const home = await fixture(t); const config = path.join(home,'.config/streamdock-ai/credits.json'); await mkdir(path.dirname(config),{recursive:true});
  await writeFile(config, JSON.stringify({sources:{flow:{enabled:true,source:'cdp',port:9223,dedicatedProfile:true}}}));
  let calls = 0; const browserReader = async () => { calls++; return {balance:12,total:null,resetLabel:null,resetAt:null,resetQuality:null,tier:'',checkedAt:new Date(1_000_000).toISOString()}; };
  const first = await readCredits({home, now:1_000_000,browserReader}); const second = await readCredits({home, now:1_001_000,browserReader});
  assert.equal(first.services[0].balance,12); assert.equal(second.services[0].balance,12); assert.equal(calls,1);
  await readCredits({home,now:1_000_000+30*60*1000,browserReader}); assert.equal(calls,2);
  const failed = await readCredits({home,now:1_000_000+60*60*1000,browserReader:async()=>null});
  assert.equal(failed.services[0].status,'stale'); assert.equal(failed.services[0].balance,12);
  assert.equal(failed.services[0].checkedAt,new Date(1_000_000).toISOString());
});

test('dedicated profile rejects symlink to a default profile and symlinked ancestors', async t => {
  if (typeof process.getuid !== 'function') return t.skip('UID is unavailable');
  const home = await fixture(t), parent = path.join(home, '.cache', 'streamdock-ai');
  await mkdir(parent, { recursive: true });
  const defaultProfile = path.join(home, 'default-browser-profile'); await mkdir(defaultProfile);
  await symlink(defaultProfile, path.join(parent, 'credits-browser'));
  let calls = 0;
  assert.equal(await verifyDedicatedChrome({ port: 9223, home, execute: async () => { calls++; throw Error('must not inspect'); } }), false);
  assert.equal(calls, 0);
  await rm(path.join(parent, 'credits-browser'));
  await rm(parent, { recursive: true });
  const outside = path.join(home, 'other-cache'); await mkdir(path.join(outside, 'credits-browser'), { recursive: true });
  await symlink(outside, parent);
  assert.equal(await verifyDedicatedChrome({ port: 9223, home, execute: async () => { calls++; throw Error('must not inspect'); } }), false);
  assert.equal(calls, 0);
});

test('tab navigation after discovery cannot read a different page', async () => {
  const setting = { enabled:true, source:'cdp', dedicatedProfile:true, port:9223 };
  let readCount = 0;
  const runWithLocation = location => async (_port, _id, expression) => {
    const document = { querySelector() { readCount++; return { innerText:'100 credits' }; } };
    return vm.runInNewContext(expression,{location,document});
  };
  const options = { verify:async()=>true, listTabs:async()=>[{type:'page',id:'A',url:'https://flow.google.com/'}], now:0 };
  const changed = await readBrowserCredit('flow',setting,{...options,readTab:runWithLocation({protocol:'https:',hostname:'elsewhere.example',port:'',pathname:'/'})});
  assert.equal(changed,null); assert.equal(readCount,0,'DOM must not be read after navigation');
  const wrongPath = await readBrowserCredit('flow',setting,{...options,readTab:runWithLocation({protocol:'https:',hostname:'flow.google.com',port:'',pathname:'/other'})});
  assert.equal(wrongPath,null); assert.equal(readCount,0);
  const allowed = await readBrowserCredit('flow',setting,{...options,readTab:runWithLocation({protocol:'https:',hostname:'flow.google.com',port:'',pathname:'/'})});
  assert.equal(allowed.balance,100); assert.equal(readCount,1);
});

test('listener rebinding or process restart aborts before returning any observation', async () => {
  const setting={enabled:true,source:'cdp',dedicatedProfile:true,port:9223};
  const initial={pid:'10',started:'Mon Nov 9 03:00:00 2026',uid:501,profile:'1:2:501',port:9223};
  for (const change of [{pid:'11'}, {started:'Mon Nov 9 03:00:01 2026'}, {uid:502}, {profile:'1:3:501'}, {port:9224}]) {
    let checks=0, read=0;
    const verify=async()=> ++checks===1 ? initial : {...initial,...change};
    const result=await readBrowserCredit('flow',setting,{verify,listTabs:async()=>[{type:'page',id:'A',url:'https://flow.google.com/'}],readTab:async()=>{read++;return {balance:'10'};},now:0});
    assert.equal(result,null); assert.equal(read,0);
  }
  let checks=0;
  const verify=async()=>++checks<=2?initial:{...initial,pid:'11'};
  const result=await readBrowserCredit('flow',setting,{verify,listTabs:async()=>[{type:'page',id:'A',url:'https://flow.google.com/'}],readTab:async()=>({balance:'10'}),now:0});
  assert.equal(result,null,'observation must be discarded if listener changes during evaluation');
});
