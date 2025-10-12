import { test, expect } from '@playwright/test';

const withTimeout = (timeout: number) => ({ timeout });

test.describe('Example app socket workflow', () => {
  test('connects to the proxy and receives a pong response', async ({ page }) => {
    await page.goto('/');

    const connectButton = page.locator('#connectBtn');
    await expect(connectButton).toBeVisible();
    await expect(connectButton).toBeEnabled();

    const serverInput = page.locator('#serverUrl');
    const serverUrl = await serverInput.inputValue();
    expect(serverUrl.trim()).toContain('https://');

    await connectButton.click();

    const statusLabel = page.locator('#connectionStatusLabel');
    await expect(statusLabel).toHaveText('Connected', withTimeout(30_000));

    const socketLabel = page.locator('#socketIdLabel');
    await expect(socketLabel).toContainText('Socket ID:', withTimeout(10_000));

    const pingInput = page.locator('#pingMessage');
    const pingButton = page.locator('#pingBtn');
    await expect(pingButton).toBeEnabled(withTimeout(10_000));

    const message = `E2E ping ${Date.now()}`;
    await pingInput.fill(message);
    await pingButton.click();

    const pingResult = page.locator('#pingResult');
    await expect(pingResult).toHaveText(/Pong from/i, withTimeout(30_000));
    await expect(pingResult).toHaveClass(/callout--success/);

    const pongTimelineItem = page
      .locator('#timeline .timeline__item')
      .filter({ has: page.locator('.timeline__event', { hasText: /pong/i }) })
      .first();
    await expect(pongTimelineItem).toBeVisible();
    await expect(pongTimelineItem.locator('.timeline__payload')).toContainText(message);
  });
});
