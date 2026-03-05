import { chromium } from 'playwright';
import path from 'path';

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const filePath = `file://${path.resolve('website/index.html')}`;
    await page.goto(filePath);
    await page.waitForTimeout(2000); // wait for animations
    await page.screenshot({ path: 'landing_page_screenshot.png', fullPage: true });
    await browser.close();
    console.log('Screenshot saved to landing_page_screenshot.png');
})();
