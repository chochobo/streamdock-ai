#!/usr/bin/env node
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLaunchdPlan, manualLaunchdCommands } from '../src/launchd.mjs';

async function codexDirectory() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir) || dir.includes(':') || /[\u0000-\u001f\u007f]/.test(dir)) continue;
    try { await fs.access(path.join(dir, 'codex'), constants.X_OK); return dir; } catch { /* next */ }
  }
  return null;
}

async function main(args) {
  let output = null, device = false, keepAlive = false, port = 4174;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--device') device = true;
    else if (args[i] === '--keep-alive') keepAlive = true;
    else if (args[i] === '--write') output = args[++i];
    else if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--help') {
      console.log('Usage: node scripts/launchd-plan.mjs [--device] [--keep-alive] [--port 4174] [--write /absolute/review.plist]');
      return;
    } else throw new Error('Unknown option');
  }
  if (args.includes('--write') && (!output || !path.isAbsolute(output) || !output.endsWith('.plist') || /[\u0000-\u001f\u007f]/.test(output))) throw new Error('--write requires an absolute .plist path');
  const plan = createLaunchdPlan({ device, keepAlive, port, codexDir: await codexDirectory() });
  await fs.access(plan.node, constants.X_OK);
  await fs.access(path.join(plan.root, 'src', 'server.mjs'), constants.R_OK);
  if (!output) { console.log(plan.plist); console.log(plan.notes.join('\n')); return; }
  // Writing directly to an auto-load directory could silently enable the agent next login.
  const parent = await fs.realpath(path.dirname(output));
  const destination = path.join(parent, path.basename(output));
  const home = await fs.realpath(os.homedir());
  const forbiddenPaths = [path.join(home, 'Library', 'LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons', '/System/Library'];
  const forbidden = await Promise.all(forbiddenPaths.map(dir => fs.realpath(dir).catch(() => path.resolve(dir))));
  if (forbidden.some(dir => destination === dir || destination.startsWith(dir + path.sep))) throw new Error('Write the review file outside launchd auto-load directories');
  await fs.writeFile(destination, plan.plist, { flag: 'wx', mode: 0o600 });
  const commands = manualLaunchdCommands(plan, destination);
  console.log(`Review file: ${destination}`);
  console.log(plan.notes.join('\n'));
  console.log('검토 후 직접 설치하려면, 기존 plist가 없는지 확인하고 각 명령의 결과를 확인하세요:');
  for (const command of commands) console.log(command);
  console.log('복사 후 검토 파일과 설치 파일이 같은지 cmp로 확인한 다음에만 bootstrap을 실행하세요.');
}

main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
