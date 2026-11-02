// libsignal writes SessionEntry objects directly to console, bypassing Baileys'
// logger. Those objects can contain private ratchet keys. Never serialize them.
export function installConsoleGuard(write:(line:string)=>void=line=>{process.stderr.write(line);}) {
  const methods=['log','info','debug','warn','error'] as const;
  const previous=methods.map(method=>console[method]);
  for(const method of methods)console[method]=(...args:unknown[])=>{
    if(args.length===1 && typeof args[0]==='string') {
      try {
        const value=JSON.parse(args[0]);
        if(value && typeof value.event==='string') {
          const allowed=['event','state','generation','code','port','pid','node','source','location'];
          const safe=Object.fromEntries(allowed.filter(key=>typeof value[key]==='string' || typeof value[key]==='number').map(key=>[key,value[key]]));
          write(JSON.stringify(safe)+'\n');return;
        }
      }catch{}
    }
    write(JSON.stringify({event:'dependency_console',level:method,detail:'omitted'})+'\n');
  };
  return ()=>{methods.forEach((method,index)=>{console[method]=previous[index];});};
}
