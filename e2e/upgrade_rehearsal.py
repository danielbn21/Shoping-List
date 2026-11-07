# Rehearses an upgrade: old app cached by the service worker, server upgraded underneath, banner appears, "Update now" fixes it.
# Needs a second copy of the project built as a higher version (see the build step in this repo history); kept as a reference script.
import subprocess, time, os, signal
from playwright.sync_api import sync_playwright
env = lambda web: dict(os.environ, DATA_DIR="/tmp/up/data", WEB_DIR=web, PORT="3997")
def start(cwd, web):
    p = subprocess.Popen(["node", "src/index.js"], cwd=cwd, env=env(web), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(2); return p
def asset(page): return page.evaluate("[...document.scripts].map(s => s.src).find(s => s.includes('/assets/'))").split('/')[-1]
srv = start("/home/claude/shoplist/server", "/home/claude/shoplist/web/dist")      # server and app at the current version
with sync_playwright() as p:
    br = p.chromium.launch(); ctx = br.new_context(); page = ctx.new_page()
    page.goto("http://127.0.0.1:3997"); page.wait_for_selector("text=Set up your server")
    page.evaluate("navigator.serviceWorker.ready"); page.reload(); page.wait_for_timeout(1500)
    print("controlled by service worker:", page.evaluate("!!navigator.serviceWorker.controller"), "| app file:", asset(page), "| banner:", page.locator(".stale").count())
    old = asset(page)
    srv.send_signal(signal.SIGTERM); srv.wait()
    srv = start("/tmp/up/serverB", "/tmp/up/web/dist")                                # server upgraded to 3.2.2
    page.reload(); page.wait_for_timeout(2500)
    print("after server upgrade, same app file served from cache:", asset(page) == old, "| banner shown:", page.locator(".stale").count() == 1)
    print("banner text:", page.locator(".stale span").inner_text())
    page.get_by_role("button", name="Update now").click(); page.wait_for_timeout(3500)
    page.wait_for_selector("text=Set up your server")
    print("after Update now -> new app file:", asset(page) != old, "| banner gone:", page.locator(".stale").count() == 0)
    br.close()
srv.send_signal(signal.SIGTERM)
