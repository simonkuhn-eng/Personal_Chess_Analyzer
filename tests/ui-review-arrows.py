"""Focused arrow timing check against a local Vite server and isolated fixture."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

html = '''<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
</script><script type="module" src="/tests/ui-product-fixture.jsx"></script></body></html>'''

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe', headless=True)
    page = browser.new_page(viewport={'width': 1500, 'height': 920})
    page.set_default_timeout(9000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/__arrow_check__?*', lambda route: route.fulfill(status=200, content_type='text/html', body=html))
    page.goto('http://127.0.0.1:5173/__arrow_check__?case=review-arrows')
    page.wait_for_function('window.__audit.contexts.length>=1')
    arrows = page.locator('.board-stage [data-arrow-kind="best"]')
    assert arrows.count() == 0, 'No initial spoiler even after live search'
    for ply, (source, target) in enumerate([('f2', 'f4'), ('e7', 'e5'), ('e2', 'e4'), ('d7', 'd5')], 1):
        page.keyboard.press('ArrowRight')
        arrows.wait_for()
        assert (arrows.get_attribute('data-from'), arrows.get_attribute('data-to')) == (source, target)
        page.wait_for_function('(n)=>window.__audit.contexts.some(c=>c.history.length===n)', arg=ply)
        page.wait_for_timeout(100)
        assert (arrows.get_attribute('data-from'), arrows.get_attribute('data-to')) == (source, target), 'Live opposing reply must not overwrite the historical alternative'
        if ply in [1, 2]:
            assert page.locator(f'[data-square="{source}"] .piece-svg').count() == 0, 'Original square may be empty'
    page.keyboard.press('ArrowLeft')
    assert (arrows.get_attribute('data-from'), arrows.get_attribute('data-to')) == ('e2', 'e4')
    page.get_by_title('Brett drehen', exact=True).click()
    assert (arrows.get_attribute('data-from'), arrows.get_attribute('data-to')) == ('e2', 'e4')
    assert page.locator('.board-arrow-legend').get_by_text(re.compile('Engine-Bestzug zu 2. Nh3')).count() == 1
    out = Path(__file__).resolve().parents[1] / 'tmp'
    out.mkdir(exist_ok=True)
    page.screenshot(path=str(out / 'review-arrow-timing.png'))
    page.keyboard.press('Home')
    assert arrows.count() == 0
    page.locator('[data-square="f2"]').click()
    page.locator('[data-square="f3"]').click()
    page.get_by_role('region', name='Variantenanalyse').wait_for()
    arrows.wait_for()
    assert arrows.get_attribute('data-from') != 'e7', 'Free variation reviews white move, not the black reply'
    before = (arrows.get_attribute('data-from'), arrows.get_attribute('data-to'))
    page.wait_for_timeout(450)
    assert before == (arrows.get_attribute('data-from'), arrows.get_attribute('data-to'))
    page.get_by_role('button', name='Zur Partie zurück', exact=False).click()
    assert arrows.count() == 0
    assert not errors, errors
    browser.close()
print('Review UI passed: no initial hint, four historical white/black arrows, empty origins, live stability, reverse navigation, flip, free variation and return.')
