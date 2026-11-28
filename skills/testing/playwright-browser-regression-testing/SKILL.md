---
name: playwright-browser-regression-testing
description: "End-to-end browser testing with Playwright covering resilient semantic locators, visual layout checks, console/network error assertions, and responsive viewports."
category: testing
version: 1.0.0
tags: [playwright, e2e, browser-testing, regression, qa]
frameworks: [playwright, react, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests, run_command]
permissions: [READ, WRITE, EXECUTE]
triggers: ["playwright", "e2e", "browser test", "ui test", "visual regression", "headless chromium"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Zero uncaught pageerror or console error messages.", "Zero broken images (naturalWidth > 0) and zero horizontal overflow.", "Semantic locators used without fixed sleeps."]
examples: ["Add Playwright E2E regression test for model selector logos and theme toggle", "Verify Skills Marketplace filters and detail modal in headless Chromium"]
provenance_origin: community-inspired
source_repos: ["obra/superpowers", "anthropics/skills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Verify real rendered user journeys in Chromium, catching broken assets, console exceptions, HTTP 5xx responses, layout overflows, and interactive regressions.

## When to use
Use when writing or running Playwright E2E tests or diagnosing frontend/full-stack browser issues.

## Required context
Read `scripts/e2e.playwright.test.ts` (or `playwright.config.*`), `package.json`, and app routes.

## Workflow
1. Attach listeners for `pageerror`, `console` (`error`), and failed network responses (`status >= 500`) on every browser test.
2. Locate elements with user-facing semantic selectors (`getByRole`, `getByLabel`, `getByPlaceholder`, `data-testid`) instead of fragile CSS paths.
3. Exercise real end-to-end flows: auth/navigation, form submit, filter/search, theme toggle, modal open/Escape close.
4. Assert zero broken images (`img.complete && img.naturalWidth > 0`) and zero horizontal overflow (`scrollWidth <= innerWidth`) on desktop and mobile viewports.
5. Ensure browser contexts and processes always close cleanly (`try/finally`).

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.
- `run_command`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Wait for explicit UI/network assertions (`expect(locator).toBeVisible()`) instead of `waitForTimeout`.
- Test both dark and light themes and mobile (~390px) + desktop (~1440px) viewports.
- Capture screenshots or traces on failure for rapid root-cause inspection.

## Anti-Patterns
- Arbitrary `page.waitForTimeout(3000)` sleeps that cause flakiness and slow suites.
- Testing only static page load without interacting with controls or checking console errors.
- Ignoring broken `<img>` tags or 404 static asset responses.

## Security Considerations
Use dedicated ephemeral test accounts and never store real user credentials inside E2E scripts.

## Performance Considerations
Reuse browser instances across isolated `BrowserContext`s for fast parallel execution.

## Testing Strategy
Run `npm run test:e2e` and verify clean exit with zero console errors or broken images.

## Verification
- Zero uncaught `pageerror` or console error messages.
- Zero broken images (`naturalWidth > 0`) and zero horizontal overflow.
- Semantic locators used without fixed sleeps.

## Checklist
- [ ] Zero uncaught `pageerror` or console error messages.
- [ ] Zero broken images (`naturalWidth > 0`) and zero horizontal overflow.
- [ ] Semantic locators used without fixed sleeps.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Add Playwright E2E regression test for model selector logos and theme toggle
- Verify Skills Marketplace filters and detail modal in headless Chromium

```ts
const brokenImages = await page.evaluate(() =>
  Array.from(document.querySelectorAll('img')).filter((img) => !img.complete || img.naturalWidth === 0).map((img) => img.src)
);
expect(brokenImages).toEqual([]);
```
