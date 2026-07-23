// _gpuInfo — which GL implementation does each puppeteer launch config actually give us?
import puppeteer from 'puppeteer';
const CFG = {
  'swiftshader (benches so far)': { headless:'new', args:['--enable-unsafe-swiftshader','--no-sandbox'] },
  'headless new, angle=metal':    { headless:'new', args:['--no-sandbox','--use-angle=metal'] },
  'headless new, default gpu':    { headless:'new', args:['--no-sandbox'] },
  'headful, angle=metal':         { headless:false, args:['--no-sandbox','--use-angle=metal'] },
  'FORCED swiftshader':           { headless:'new', args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'] },
};
for (const [name,cfg] of Object.entries(CFG)) {
  try {
    const br = await puppeteer.launch(cfg); const pg = await br.newPage();
    await pg.setContent('<canvas id=c></canvas>');
    const r = await pg.evaluate(() => {
      const gl = document.getElementById('c').getContext('webgl2');
      if (!gl) return 'NO WEBGL2';
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      return (e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    });
    console.log(`${name.padEnd(30)} → ${r}`);
    await br.close();
  } catch(e) { console.log(`${name.padEnd(30)} → FAILED: ${e.message.slice(0,70)}`); }
}
