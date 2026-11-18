const readline = require('node:readline');
const mode = process.argv[2] || 'success';
const fs = require('node:fs');
const marker = process.argv[3];
let firstRun = false;
if ((mode === 'restart' || mode === 'after-two-restart') && marker) { firstRun = !fs.existsSync(marker); if (firstRun) fs.writeFileSync(marker,'first'); }
let received = 0;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (mode !== 'startup-timeout') emit({event:'ready',simulated:mode==='simulate'});
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  received++;
  if (mode === 'exit' || (mode === 'restart' && firstRun)) return process.exit(1);
  if (mode === 'timeout' || mode === 'startup-timeout') return;
  if (mode === 'ack') emit({event:'device-ack'});
  if (mode === 'key') { emit({event:'key',index:0,pressed:true}); emit({event:'key',index:0,pressed:false}); }
  if (mode === 'keyburst') { for (let i=0;i<20;i++) emit({event:'key',index:0,pressed:true}); for (let i=0;i<20;i++) emit({event:'key',index:0,pressed:false}); }
  if (mode === 'delayed-key') setTimeout(() => emit({event:'key',index:0,pressed:true}), 50);
  const ack = (mode === 'error' || ((mode === 'after-two-error' || (mode === 'after-two-restart' && firstRun)) && received > 2)) ? {id:request.id,ok:false,message:'write failure'} : mode === 'wrong-id' ? {id:request.id+1,ok:true} : {id:request.id,ok:true};
  setTimeout(() => emit(ack), mode === 'delay' || mode === 'delayed-key' ? 80 : 0);
});
