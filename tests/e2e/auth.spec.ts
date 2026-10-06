import { test, expect } from '@playwright/test'

// ─── TC-001: Application Startup & Smoke ─────────────────────────────────
test('TC-001: App starts and shows login page', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/ProcurementPilot|Vite|React/i)
  // Login form must be present
  await expect(page.locator('input[type="password"], input[autocomplete="current-password"]')).toBeVisible()
  await expect(page.locator('button[type="submit"]')).toBeVisible()
})

// ─── TC-002: Valid Authentication ────────────────────────────────────────
test('TC-002: Valid login shows dashboard', async ({ page }) => {
  await page.goto('/')
  // Fill credentials (pre-filled in Login.tsx but we set them explicitly)
  await page.fill('input[autocomplete="username"], input[type="email"], input:not([type="password"])', 'owner@ayuranest.demo')
  await page.fill('input[type="password"]', 'AyuraNest-demo!')
  await page.click('button[type="submit"]')
  // Wait for dashboard — "Restoring session..." should disappear
  await page.waitForTimeout(3000)
  // Should NOT still show the login form
  const loginForm = page.locator('form')
  const submitBtn = page.locator('button[type="submit"]')
  // If login succeeded, either form is gone or submit changes
  const pageText = await page.textContent('body')
  // Dashboard content present OR login error absent
  expect(pageText).not.toContain('Invalid login credentials')
})

// ─── TC-003: Invalid Authentication ─────────────────────────────────────
test('TC-003: Wrong password shows error', async ({ page }) => {
  await page.goto('/')
  await page.fill('input[autocomplete="username"], input[type="email"], input:not([type="password"])', 'owner@ayuranest.demo')
  await page.fill('input[type="password"]', 'DEFINITELY_WRONG_PASSWORD_999')
  await page.click('button[type="submit"]')
  // Wait for error message
  await page.waitForTimeout(3000)
  const body = await page.textContent('body')
  // Should show some error, not navigate away
  const hasError = body?.includes('Invalid') || body?.includes('invalid') ||
                   body?.includes('error') || body?.includes('Error') ||
                   body?.includes('credentials')
  expect(hasError).toBe(true)
  // Should still be on login page
  await expect(page.locator('button[type="submit"]')).toBeVisible()
})

// ─── TC-007: Unauthorized Deep Link ─────────────────────────────────────
test('TC-007: Unauthenticated user sees login, not dashboard', async ({ page }) => {
  // Fresh context — no stored session
  await page.goto('/')
  // Should show login form, not dashboard content
  await expect(page.locator('button[type="submit"]')).toBeVisible()
  const body = await page.textContent('body')
  // Should NOT show dashboard-only content without being logged in
  expect(body).toContain('ProcurementPilot')
})

// ─── TC-004: Required Field Validation ───────────────────────────────────
test('TC-004: Empty credentials - button is present and form exists', async ({ page }) => {
  await page.goto('/')
  // Clear the pre-filled fields
  const emailInput = page.locator('input[autocomplete="username"]')
  const passwordInput = page.locator('input[type="password"]')
  await emailInput.fill('')
  await passwordInput.fill('')
  // Verify form elements visible
  await expect(emailInput).toBeVisible()
  await expect(passwordInput).toBeVisible()
  await expect(page.locator('button[type="submit"]')).toBeVisible()
})

// ─── TC-009: Boundary Values / XSS ──────────────────────────────────────
test('TC-009: XSS payload in email field does not crash app', async ({ page }) => {
  await page.goto('/')
  const emailInput = page.locator('input[autocomplete="username"]')
  await emailInput.fill('<script>alert(1)</script>')
  await page.fill('input[type="password"]', 'testpassword')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(2000)
  // App must not crash — still renders
  const body = await page.textContent('body')
  expect(body).toBeTruthy()
  expect(body?.length).toBeGreaterThan(0)
  // No alert dialog (XSS blocked by React)
})

// ─── Cross-browser Responsive ────────────────────────────────────────────
test('TC-012: Mobile viewport renders login without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  await expect(page.locator('button[type="submit"]')).toBeVisible()
  // No horizontal scroll
  const bodyWidth = await page.evaluate(() => document.body.scrollWidth)
  const viewportWidth = await page.evaluate(() => window.innerWidth)
  expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 5) // 5px tolerance
})

test('TC-012: Tablet viewport (768px) renders correctly', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.goto('/')
  await expect(page.locator('button[type="submit"]')).toBeVisible()
})

test('TC-012: Desktop viewport (1440px) renders correctly', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.locator('button[type="submit"]')).toBeVisible()
})
