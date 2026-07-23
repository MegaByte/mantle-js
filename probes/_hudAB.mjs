import puppeteer from 'puppeteer';
const PORT=5174, GAME=process.env.GAME||'color-match', OUT='probes/_hudCaptureOut';
const browser = await puppeteer.launch({ headless:false, args:['--no-sandbox','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width:900, height:1000, deviceScaleFactor:2 });
await page.goto(`http://localhost:${PORT}/?game=${GAME}&autostart=1`, { waitUntil:'load', timeout:40000 });
await new Promise(r=>setTimeout(r,11000));        // question shown + settled (no tap → stays)
await page.screenshot({ path:`${OUT}/iab_lb.png` });
await page.evaluate(()=>{ globalThis.__MANTLE_DEBUG__=true; globalThis.__MANTLE_FORCE_SLUG=true; });
await new Promise(r=>setTimeout(r,350));
await page.screenshot({ path:`${OUT}/iab_slug.png` });
console.log('settled same-frame LB + Slug done');
await new Promise(r=>setTimeout(r,300)); await browser.close();
