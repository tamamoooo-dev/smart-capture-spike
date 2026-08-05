import { devices, webkit } from 'playwright';

const site = process.env.SMART_CAPTURE_URL || 'http://127.0.0.1:5051/index.html';
const fixture = 'C:/Users/majed/Documents/school/output/smart_capture_spike/fixtures/01_good_framing.jpg';
const browser = await webkit.launch({headless: true});

async function capture(context) {
  const page = await context.newPage();
  await page.goto(site);
  await page.locator('#testFile').setInputFiles(fixture);
  await page.waitForTimeout(2000);
  const mode = await page.locator('#modeBadge').innerText();
  const registrationState = await page.locator('[data-check="registrationReady"]').getAttribute('class');
  if (mode === 'تم الالتقاط تلقائياً' || registrationState !== 'fail') {
    throw new Error(`Registration gate did not fail closed: ${JSON.stringify({mode, registrationState})}`);
  }
  await page.locator('#manualCapture').waitFor({state: 'visible'});
  await page.locator('#manualCapture').click();
  await page.locator('#resultCard').waitFor({state: 'visible', timeout: 10000});
  return page;
}

const iphone = devices['iPhone 13'];
const shareContext = await browser.newContext({...iphone});
await shareContext.addInitScript(() => {
  Object.defineProperty(navigator, 'canShare', {configurable: true, value: data => data.files?.[0]?.type === 'image/jpeg'});
  Object.defineProperty(navigator, 'share', {configurable: true, value: async data => {
    window.__shareResult = {count: data.files.length, name: data.files[0].name, type: data.files[0].type};
  }});
});
const sharePage = await capture(shareContext);
await sharePage.locator('#downloadCapture').click();
const shared = await sharePage.evaluate(() => window.__shareResult);
if (shared?.count !== 1 || shared.name !== 'smart-capture.jpg' || shared.type !== 'image/jpeg') {
  throw new Error(`Web Share branch failed: ${JSON.stringify(shared)}`);
}
await shareContext.close();

const fallbackContext = await browser.newContext({...iphone});
await fallbackContext.addInitScript(() => {
  Object.defineProperty(navigator, 'canShare', {configurable: true, value: undefined});
  Object.defineProperty(navigator, 'share', {configurable: true, value: undefined});
  window.open = (url, target) => {
    window.__openResult = {url, target};
    return {opener: window};
  };
});
const fallbackPage = await capture(fallbackContext);
await fallbackPage.locator('#downloadCapture').click();
const opened = await fallbackPage.evaluate(() => window.__openResult);
if (!opened?.url?.startsWith('blob:') || opened.target !== '_blank') {
  throw new Error(`New-tab fallback failed: ${JSON.stringify(opened)}`);
}
await fallbackContext.close();

await browser.close();
console.log(JSON.stringify({webShare: shared, fallback: opened, site}));
