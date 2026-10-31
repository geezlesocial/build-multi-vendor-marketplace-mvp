import { expect, type Page } from '@playwright/test';

/** Keep overflow assertions actionable across browser engines and viewport widths. */
export async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const overflowCandidates = Array.from(document.body.querySelectorAll<HTMLElement>('*'))
      .map(element => {
        const bounds = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || undefined,
          className: typeof element.className === 'string' ? element.className.slice(0, 120) : undefined,
          left: Math.round(bounds.left * 100) / 100,
          right: Math.round(bounds.right * 100) / 100,
          width: Math.round(bounds.width * 100) / 100
        };
      })
      .filter(element => element.width > 0 && (element.left < 0 || element.right > viewportWidth))
      .sort((left, right) => right.right - left.right)
      .slice(0, 12);

    return {
      clientWidth: viewportWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowCandidates
    };
  });

  expect(metrics.scrollWidth, `Horizontal overflow diagnostics: ${JSON.stringify(metrics)}`)
    .toBeLessThanOrEqual(metrics.clientWidth);
}
