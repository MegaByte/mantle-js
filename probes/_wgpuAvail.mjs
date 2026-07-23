// _wgpuAvail — is WebGPU reachable under our puppeteer configs, and on which backend?
import http from 'http';
import puppeteer from 'puppeteer';
const HTML = `<!DOCTYPE html><html><body><canvas id=c></canvas></body></html>`;
const server = http.createServer((q,s)=>{s.writeHead(200,{'content-type':'text/html'});s.end(HTML);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const CFG = {
  'headful, default':       { headless:false, args:['--no-sandbox'] },
  'headful, unsafe-webgpu': { headless:false, args:['--no-sandbox','--enable-unsafe-webgpu'] },
  'headful, metal+unsafe':  { headless:false, args:['--no-sandbox','--use-angle=metal','--enable-unsafe-webgpu'] },
  'headless new, unsafe':   { headless:'new', args:['--no-sandbox','--enable-unsafe-webgpu'] },
  'headless new, default':  { headless:'new', args:['--no-sandbox'] },
};
for (const [name,cfg] of Object.entries(CFG)) {
  let br;
  try {
    br = await puppeteer.launch(cfg); const pg = await br.newPage();
    await pg.goto(`http://127.0.0.1:${port}/`, {waitUntil:'load'});
    const r = await pg.evaluate(async () => {
      const sec = window.isSecureContext;
      if (!navigator.gpu) return `NO navigator.gpu (secureContext=${sec}, ua=${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0]})`;
      const a = await navigator.gpu.requestAdapter();
      if (!a) return `NO adapter (secureContext=${sec})`;
      const d = await a.requestDevice().catch(()=>null);
      const i = a.info || {};
      const cv = document.getElementById('c').getContext('webgpu');
      return `adapter=${i.vendor||'?'}/${i.architecture||'?'} ${i.description||''} device=${!!d} canvasCtx=${!!cv} maxStorage=${(a.limits.maxStorageBufferBindingSize/1048576).toFixed(0)}MB maxWG=${a.limits.maxComputeWorkgroupSizeX}`;
    });
    console.log(`${name.padEnd(24)} → ${r}`);
  } catch(e) { console.log(`${name.padEnd(24)} → FAILED: ${e.message.slice(0,70)}`); }
  finally { if (br) await br.close(); }
}
server.close();
