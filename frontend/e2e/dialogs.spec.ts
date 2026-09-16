import { expect, test, type Page } from '@playwright/test'

async function loadDigest(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle(/claudesk/i)
  await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible()
  await page.getByRole('navigation').getByRole('button', { name: 'DIGEST', exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear()
  })
})

test('add paper dialog focuses the DOI field and closes through Base UI dismissal', async ({ page }) => {
  await loadDigest(page)

  const addPaperButton = page.getByRole('button', { name: 'Add paper by DOI' })
  await addPaperButton.click()

  const dialog = page.getByRole('dialog', { name: 'Add Paper' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: 'DOI' })).toBeFocused()
  const saveCheckbox = dialog.getByRole('checkbox', { name: 'Save' })
  await expect(saveCheckbox).toBeChecked()
  await saveCheckbox.click()
  await expect(saveCheckbox).not.toBeChecked()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(addPaperButton).toHaveAttribute('aria-expanded', 'false')

  await addPaperButton.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})
