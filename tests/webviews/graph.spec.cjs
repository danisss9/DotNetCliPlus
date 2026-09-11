const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { buildNugetGraphHtml } = require('../../out/nuget-graph-html');
let server, base;
function fixture(size = 3) {
  const root = 'workspace', project = 'App.csproj', framework = 'net10.0';
  const nodes = [{ id: root, name: root, kinds: [], status: [] }, { id: project, name: project, kinds: ['project'], status: ['Project'] }, { id: framework, name: framework, kinds: ['framework'], status: ['Framework'] }];
  const edges = [{ id: 'project', source: root, target: project, name: project, kinds: ['project'] }, { id: 'framework', source: project, target: framework, name: framework, kinds: ['framework'] }];
  for (let i = 0; i < size; i++) {
    nodes.push({ id: `p${i}`, name: `Package${i}`, version: '1.0.0', kinds: ['package'], status: i === 2 ? ['missing'] : [] });
    edges.push({ id: `e${i}`, source: i ? `p${i - 1}` : framework, target: `p${i}`, name: `Package${i}`, kinds: ['package'] });
  }
  edges.push({ id: 'cycle', source: `p${size - 1}`, target: 'p0', name: 'Package0', kinds: ['package'] });
  return { root, source: 'Restored', nodes, edges, diagnostics: ['Restore after changing central package versions.'] };
}
test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(buildNugetGraphHtml(`${base}/nuget-graph-webview.js`, `${base}/nuget-graph-webview.css`, base, 'test')); }
    else if (['/nuget-graph-webview.js', '/nuget-graph-webview.css'].includes(request.url)) { response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css'); response.end(fs.readFileSync(path.join(__dirname, '../../dist', request.url.slice(1)))); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => new Promise(resolve => server.close(resolve)));
async function mount(page, graph = fixture()) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message) }); });
  await page.goto(base);
  await page.evaluate(graph => window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph } })), graph);
  await expect(page.locator('#summary')).toContainText('Restored'); return errors;
}
const count = page => page.evaluate(() => document.getElementById('graph')._cyreg.cy.nodes().length);
test('expand, cycle-safe reset, search reveals transitive package and unresolved filter', async ({ page }) => {
  const errors = await mount(page);
  expect(await count(page)).toBe(2);
  await page.locator('#expand-all').click(); expect(await count(page)).toBe(6);
  await page.locator('#reset').click(); expect(await count(page)).toBe(2);
  await page.locator('#search').fill('Package1'); await page.locator('#results button').filter({ hasText: 'Package1 1.0.0' }).click();
  await expect(page.locator('#details h2')).toHaveText('Package1'); expect(await count(page)).toBeGreaterThan(2);
  await page.locator('#unresolved').click(); await expect(page.locator('#results button')).toHaveCount(1);
  await expect(page.locator('#results')).toContainText('Package2'); expect(errors).toEqual([]);
});
test('security bridge and refresh failure keep prior graph usable', async ({ page }) => {
  await mount(page); await page.locator('#security-scan').click();
  expect(await page.evaluate(() => window.messages.some(m => m.command === 'securityScan'))).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'securityScanFinished' } })));
  await expect(page.locator('#security-scan')).toBeEnabled();
  await page.locator('#refresh').click();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'Restore snapshot unreadable' } })));
  await expect(page.locator('#summary')).toContainText('Refresh failed'); expect(await count(page)).toBe(2);
});
test('5000 packages expand without animation, stable positions and responsive zoom', async ({ page }) => {
  const errors = await mount(page, fixture(5000));
  await page.locator('#expand-all').click(); expect(await count(page)).toBe(5003);
  const before = await page.evaluate(() => document.getElementById('graph')._cyreg.cy.getElementById('p0').position());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.getElementById('graph')._cyreg.cy.getElementById('p0').position())).toEqual(before);
  const zoom = await page.evaluate(() => document.getElementById('graph')._cyreg.cy.zoom());
  await page.locator('#graph').hover(); await page.mouse.wheel(0, -200);
  await expect.poll(() => page.evaluate(() => document.getElementById('graph')._cyreg.cy.zoom())).toBeGreaterThan(zoom);
  await page.screenshot({ path: '.webview-test-results/nuget-graph.png' }); expect(errors).toEqual([]);
});
