// Deterministic selection probe: drive strata_use with the EXACT capabilities the model asked for,
// and report which recalls come back. No LLM, no benchmark run.
const { spawn } = require('child_process');
const path = require('path');
const SIM = process.argv[2], PROJ = process.argv[3];
const caps = JSON.parse(process.argv[4]);
const task = process.argv[5];
const child = spawn(process.execPath, [path.join(SIM, 'dist', 'src', 'mcp-server.js')], { cwd: SIM, stdio: ['pipe','pipe','pipe'] });
let err=''; child.stderr.on('data', d => err += d);
let buf=''; const seen=[];
child.stdout.on('data', d => { buf+=d; let i; while((i=buf.indexOf('\n'))>=0){ const l=buf.slice(0,i).trim(); buf=buf.slice(i+1); if(l) try{seen.push(JSON.parse(l))}catch{} } });
const send=o=>child.stdin.write(JSON.stringify(o)+'\n');
(async()=>{
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'p',version:'0'}}});
  await new Promise(r=>setTimeout(r,1500));
  send({jsonrpc:'2.0',method:'notifications/initialized',params:{}});
  await new Promise(r=>setTimeout(r,1200));
  send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'strata_use',arguments:{dir:PROJ,task,capabilities:caps}}});
  await new Promise(r=>setTimeout(r,30000));
  const res=seen.find(m=>m.id===2);
  const text=res?.result?.content?.map(c=>c.text).join('\n')||'(no response)';
  const ids=[...new Set(text.match(/\b[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v\d+\b/g)||[])];
  console.log('DELIVERED:', ids.join(', ')||'(none / declined)');
  console.log('composed  :', /composed on hub/.test(err)?'hub':'local/declined');
  child.kill(); process.exit(0);
})();
