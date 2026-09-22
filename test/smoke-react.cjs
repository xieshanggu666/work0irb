/**
 * React 版冒烟测试：
 *  1. 打开页面，确认无致命运行时错误；
 *  2. 初始应弹出「新建工厂」弹窗；
 *  3. 点开始游戏，等待进入地图；
 *  4. 放置矿机/熔炉/传送带等，跑若干秒仿真，检查 UI 面板可交互。
 */
const { chromium } = require('playwright');

const URL = process.env.URL || 'http://localhost:5174/';
const errors = [];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // 初始弹窗：新建工厂
  const modal = page.locator('.modal-mask');
  if (!(await modal.count())) throw new Error('初始新建游戏弹窗未出现');
  console.log('✓ 初始弹窗出现');

  // 选地图场景第二张（沙漠）-> 小尺寸 -> 开始
  await page.locator('.map-card').nth(0).click();
  await page.locator('#ng-maps').waitFor(); // 重新渲染
  await page.getByRole('button', { name: /开始游戏/ }).click();
  await page.waitForTimeout(500);
  if (await page.locator('.modal-mask').count()) throw new Error('开始游戏后弹窗未关闭');
  console.log('✓ 进入游戏');

  // 顶栏时间在走动
  const time1 = await page.locator('.tb-item').first().textContent();
  await page.waitForTimeout(1200);
  const time2 = await page.locator('.tb-item').first().textContent();
  if (time1 === time2) throw new Error('游戏时间未推进: ' + time1);
  console.log('✓ 仿真在运行', time1, '->', time2);

  // 工具栏：切到物流分类，选传送带
  await page.locator('.tb-cats button', { hasText: '物流' }).click();
  await page.locator('.bld-btn').filter({ has: page.locator('.bld-name', { hasText: '传送带' }) }).first().click();
  await page.waitForTimeout(100);
  console.log('✓ 工具栏交互正常');

  // 在地图中央点几格放传送带
  const canvas = page.locator('.map-canvas');
  const box = await canvas.boundingBox();
  for (let i = 0; i < 5; i++) {
    await page.mouse.click(box.x + box.width / 2 + i * 33, box.y + box.height / 2);
    await page.waitForTimeout(40);
  }
  console.log('✓ 地图点击放置无异常');

  // 切回采集，选矿机，在地图上点击
  await page.locator('.tb-cats button', { hasText: '采集' }).click();
  await page.locator('.bld-btn').filter({ has: page.locator('.bld-name', { hasText: '矿机' }) }).first().click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - 40);
  await page.waitForTimeout(100);

  // 右键取消幽灵，点击已有建筑应出现信息面板
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.waitForTimeout(100);

  // 打开科技树
  await page.getByRole('button', { name: /科技/ }).click();
  await page.waitForTimeout(300);
  if (!(await page.locator('#tech-tree').count())) throw new Error('科技树未打开');
  console.log('✓ 科技树打开');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 菜单 -> 存档管理
  await page.getByRole('button', { name: '☰' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: '存档管理' }).click();
  await page.waitForTimeout(300);
  const saveRows = await page.locator('.save-row').count();
  if (saveRows !== 4) throw new Error('存档槽位显示异常: ' + saveRows);
  console.log('✓ 存档管理弹窗正常（4 槽位）');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 右侧面板各 tab 都能切
  for (const name of ['统计', '施工', '维修', '合同', '日志', '信息']) {
    await page.locator('.sp-tabs button', { hasText: name }).click();
    await page.waitForTimeout(60);
  }
  console.log('✓ 右侧面板所有页签可切换');

  // 让仿真再跑 2 秒
  await page.waitForTimeout(2000);

  // 验证自动存档已写入 localStorage
  const slots = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
    return out;
  });
  if (!slots.some(k => k.startsWith('fg.save.'))) throw new Error('未找到存档键: ' + slots);
  console.log('✓ 存档系统正常', slots.join(','));

  if (errors.length) {
    console.error('\n运行时错误:');
    errors.forEach(e => console.error(' ', e));
    process.exit(1);
  }
  console.log('\n全部冒烟检查通过，无 console error。');
  await browser.close();
})().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });
