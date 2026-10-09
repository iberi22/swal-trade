import { test as base, expect } from '@playwright/test';
import { collectProblems, installCspProbe, installSiteMocks, type Problems } from '../fixtures/browser';

export const test = base.extend<{ problems: Problems }>({
  page: async ({ page }, use) => {
    await installCspProbe(page);
    await installSiteMocks(page);
    await use(page);
  },
  problems: async ({ page }, use) => {
    await use(collectProblems(page));
  },
});

export { expect };

export async function assertClean(page: import('@playwright/test').Page, problems: Problems) {
  const csp = await problems.csp();
  expect(csp, `CSP violations: ${csp.join(' | ')}`).toEqual([]);
  expect(problems.pageErrors, problems.pageErrors.join('\n')).toEqual([]);
  expect(problems.consoleErrors, problems.consoleErrors.join('\n')).toEqual([]);
}
