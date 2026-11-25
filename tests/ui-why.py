"""Targeted Why workflow. Fake engine bridge; real App/board and isolated storage."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

out = Path(__file__).resolve().parents[1] / 'tmp' / 'why-ui'
out.mkdir(parents=True, exist_ok=True)
html = '''<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
</script><script type="module" src="/tests/ui-product-fixture.jsx"></script></body></html>'''
checks, errors = [], []
def ok(name, condition):
    assert condition, name
    checks.append(name)
    print('OK', name, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe', headless=True)
    def create(case):
        page = browser.new_page(viewport={'width': 1500, 'height': 920})
        page.set_default_timeout(12000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/__why__?*', lambda route: route.fulfill(status=200, content_type='text/html', body=html))
        page.goto('http://127.0.0.1:5173/__why__?case=' + case)
        page.locator('.review-layout').wait_for()
        page.keyboard.press('ArrowRight')
        return page
    page = create('review-why')
    ok('No extra Why search until button clicked', page.evaluate('window.__audit.whyCalls.length') == 0)
    original_board = page.locator('.board-stage .board-container').bounding_box()
    page.get_by_role('button', name='Warum?', exact=True).click()
    panel = page.get_by_role('region', name='Warum dieser Zug?')
    panel.locator('.why-summary').wait_for()
    ok('Selected move and own perspective are explicit', 'Rxd7' in panel.locator('header').inner_text() and 'Sicht von Weiß' in panel.inner_text())
    ok('Queen recapture is explicitly searched even outside PV', page.evaluate('window.__audit.whyCalls.some(c=>c.history.join(" ")==="d1d7 d8d7")'))
    ok('Overload has concrete evidence and branch', panel.locator('[data-motif="T12"]').count() == 1 and panel.locator('[data-why-line="reply"]').count() >= 1)
    ok('Open explanation preserves board size and position', page.locator('.board-stage .board-container').bounding_box() == original_board)
    panel.screenshot(path=str(out / 'explanation.png'))
    panel.locator('[data-motif="T12"]').get_by_role('button', name='Entscheidenden Moment zeigen').click()
    page.get_by_role('region', name='Variantenanalyse').wait_for()
    ok('Proof jumps to actual checkmate on board', page.locator('[data-square="f8"] img[alt="wR"]').count() == 1)
    ok('Explanation remains anchored while showing its proof', panel.locator('header').get_by_text(re.compile('1. Rxd7')).count() == 1)
    panel.get_by_role('button', name='Alternative auf dem Brett wählen', exact=True).click()
    panel.get_by_text('Das Brett zeigt die Stellung davor.', exact=False).wait_for()
    ok('Picker restores pre-move position', page.locator('[data-square="d1"] img[alt="wR"]').count() == 1)
    page.locator('[data-square="g1"]').click()
    page.locator('[data-square="h1"]').click()
    page.wait_for_function("document.querySelector('.why-control select').value==='g1h1'")
    panel.locator('.why-summary').wait_for()
    ok('Own board move becomes a searched alternative', page.evaluate('window.__audit.whyCalls.some(c=>c.options.searchMoves?.includes("g1h1"))'))
    ok('Summary explains the chosen alternative', 'Kh1' in panel.locator('.why-summary').inner_text())
    ok('Picker selection leaves original game untouched', page.evaluate('window.__audit.originalGame===window.__audit.getGame() && window.__audit.saved===0'))
    reply_select = panel.get_by_label('Gegnerantwort für Warum-Vergleich', exact=True)
    reply_select.select_option('d8e8')
    panel.locator('.why-summary').wait_for()
    ok('Custom opponent reply is searched with full history', page.evaluate('window.__audit.whyCalls.some(c=>c.history.join(" ")==="d1d7 d8e8")'))
    for width, height in [(1500, 920), (1100, 700)]:
        page.set_viewport_size({'width': width, 'height': height})
        ok(f'Why panel scrolls internally at {width}', panel.bounding_box()['y'] + panel.bounding_box()['height'] <= height and page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
    page.set_viewport_size({'width': 1500, 'height': 920})
    panel.get_by_role('button', name='Erklärung schließen', exact=True).click()
    ok('Close returns to original reviewed position', page.locator('[data-square="d7"] img[alt="wR"]').count() == 1 and page.locator('[data-square="d8"] img[alt="bQ"]').count() == 1)
    page.close()

    slow = create('review-why-hold')
    slow.get_by_role('button', name='Warum?', exact=True).click()
    slow.wait_for_function('window.__audit.pendingWhy.length===1')
    slow.get_by_role('button', name='Erklärung schließen', exact=True).click()
    slow.evaluate('window.__audit.pendingWhy[0]()')
    slow.wait_for_timeout(200)
    ok('Closing cancels request and ignores delayed result', slow.evaluate('window.__audit.cancelledWhy.some(id=>id.startsWith("why-"))') and slow.locator('.why-panel').count() == 0)
    ok('Cancelled work does not continue to more searches', slow.evaluate('window.__audit.whyCalls.length') == 1)
    slow.close()

    empty = create('review-why-empty')
    empty.get_by_role('button', name='Warum?', exact=True).click()
    empty.get_by_role('alert').wait_for()
    ok('No invented reasons for unavailable engine', empty.locator('.why-summary').count() == 0 and empty.get_by_role('button', name='Erneut versuchen', exact=True).is_enabled())
    ok('No UI exceptions', not errors)
    empty.close()
    browser.close()
print(f'{len(checks)} Why UI checks passed.')
