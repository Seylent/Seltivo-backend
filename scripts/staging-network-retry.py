"""Drop a committed request response in the staging browser, then retry it."""

import sys
import uuid

from playwright.sync_api import sync_playwright


origin = sys.argv[1] if len(sys.argv) > 1 else "https://seltivo-staging.seltivostudio.workers.dev"
email = f"retry-{uuid.uuid4()}@example.test"
password = f"RetrySmoke-{uuid.uuid4()}!"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    registered = context.request.post(
        origin + "/api/v1/auth/register",
        data={"email": email, "password": password, "name": "Retry Smoke"},
        headers={"Origin": origin},
    )
    assert registered.status == 201, registered.status

    page.goto(origin + "/login?next=/studio/fashion-01", wait_until="domcontentloaded")
    page.locator("#login-email").fill(email)
    page.locator("#login-password").fill(password)
    page.locator(".auth-submit").click()
    page.locator(".studio-topbar").wait_for(timeout=30000)
    page.get_by_role("button", name="Надіслати макет").click()
    modal = page.get_by_role("dialog", name="Надіслати мій макет")
    modal.get_by_placeholder("@username або телефон").fill("@retry_test")
    modal.get_by_role("button", name="Зберегти в кабінеті").click()
    modal.get_by_text("Конфігурацію збережено в кабінеті.").wait_for(timeout=30000)

    state = {"committed_id": None, "dropped": False}

    def drop_first_response(route):
        if route.request.method != "POST" or state["dropped"]:
            route.continue_()
            return
        response = route.fetch()
        assert response.status == 201, response.status
        state["committed_id"] = response.json()["id"]
        state["dropped"] = True
        route.abort("failed")

    page.route("**/api/v1/requests", drop_first_response)
    modal.get_by_role("button", name="Надіслати заявку").click()
    modal.get_by_role("alert").wait_for(timeout=30000)
    assert state["dropped"] and state["committed_id"]
    modal.get_by_role("button", name="Надіслати заявку").click()
    modal.get_by_text("створено. Відстежуйте її").wait_for(timeout=30000)
    assert state["committed_id"] in modal.inner_text()

    requests = context.request.get(origin + "/api/v1/requests", headers={"Origin": origin})
    assert requests.status == 200, requests.status
    items = requests.json()["items"]
    assert len(items) == 1 and items[0]["id"] == state["committed_id"], items
    context.close()
    browser.close()

print("Staging browser retry passed: response lost after commit, retry returned the same request.")
