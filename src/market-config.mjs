import { promises as fs, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES=32_000, MAX_ITEMS=10;
const empty=status=>({portfolio:[],favoriteSectors:[],status});
/** Read only explicitly configured market symbols; never make a network request. */
export async function readMarketConfig({home=os.homedir(),file=path.join(home,'.config','streamdock-ai','market.json')}={}) {
  let handle;
  try {
    handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>MAX_BYTES) return empty('unavailable');
    const raw=await handle.readFile('utf8');
    if(Buffer.byteLength(raw)>MAX_BYTES)return empty('unavailable');
    const data=JSON.parse(raw);
    if(!data||typeof data!=='object'||Array.isArray(data))return empty('unavailable');
    const portfolio=data.portfolio??[],favoriteSectors=data.favoriteSectors??[];
    if(!Array.isArray(portfolio)||!Array.isArray(favoriteSectors)||portfolio.length>MAX_ITEMS||favoriteSectors.length>MAX_ITEMS)return empty('unavailable');
    if(portfolio.some(v=>typeof v!=='string'||!/^[A-Za-z0-9.\-]{1,16}$/.test(v)))return empty('unavailable');
    if(favoriteSectors.some(v=>typeof v!=='string'||!v.trim()||Array.from(v).length>50||/[\p{Cc}\p{Cf}]/u.test(v)))return empty('unavailable');
    return {portfolio:[...new Set(portfolio)],favoriteSectors:[...new Set(favoriteSectors.map(v=>v.trim()))],status:'ok'};
  } catch(error) {
    return empty(error?.code==='ENOENT'?'unconfigured':'unavailable');
  } finally { await handle?.close().catch(()=>{}); }
}
