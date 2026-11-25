"""Focused real-App UI check. Fake profile/bridge, isolated browser storage."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

out = Path(__file__).resolve().parents[1] / 'tmp' / 'opening-phase-ui'
out.mkdir(parents=True, exist_ok=True)
html = '''<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
</script><script type="module" src="/tests/ui-opening-phase-fixture.jsx"></script></body></html>'''
checks, errors = [], []
def ok(name, condition):
    assert condition, name
    checks.append(name)
    print('OK', name, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe', headless=True)
    page = browser.new_page(viewport={'width': 1500, 'height': 920})
    page.set_default_timeout(16000)
    page.on('pageerror', lambda err: errors.append(str(err)))
    page.route('**/__opening_phase__', lambda route: route.fulfill(status=200, content_type='text/html', body=html))
    page.goto('http://127.0.0.1:5173/__opening_phase__')
    page.get_by_role('button', name='Fehler-Diagnostik', exact=True).click()
    panel = page.get_by_role('region', name='Eröffnungsqualität')
    panel.wait_for()
    late = panel.locator('tbody tr').filter(has=page.locator('strong', has_text=re.compile('^Polish Opening')))
    early = panel.locator('tbody tr').filter(has=page.locator('strong', has_text=re.compile('^Caro-Kann')))
    ok('Late-only Polish game has zero opening errors and 100% opening accuracy', '0 Fehler im Zugfenster' in late.inner_text() and '100 %' in late.inner_text())
    ok('Empty early-error action disabled', late.get_by_role('button', name='Eröffnungsfehler ansehen').is_disabled())
    ok('Single early inaccuracy shown, late blunder excluded', '1 Fehler im Zugfenster' in early.inner_text() and 'Einzelbeobachtung' in early.inner_text())
    panel.screenshot(path=str(out / 'diagnosis.png'))
    early.get_by_role('button', name='Eröffnungsfehler ansehen').click()
    page.get_by_text(re.compile('eigene Züge 1–12')).wait_for()
    page.locator('.training-deck-board-column .board-container').wait_for()
    ok('Focused cards include inaccuracies without changing ordinary preferences', page.get_by_role('checkbox', name=re.compile('Leichte Fehler')).is_checked())
    ok('Only one early card enters training', '0/1 gemeistert' in page.locator('.training-deck-view').inner_text())
    ok('Focused filter says own black opening window', 'Schwarz' in page.locator('.training-deck-view').inner_text() and 'eigene Züge 1–12' in page.locator('.training-deck-view').inner_text())
    page.get_by_role('button', name='Fehler-Diagnostik', exact=True).click()
    panel.wait_for()
    early.get_by_role('button', name='Antworten trainieren').click()
    page.locator('.opening-trainer-playerbar').wait_for()
    ok('Response repertoire keeps black perspective', 'Du spielst Schwarz' in page.locator('.opening-trainer-playerbar').inner_text())
    ok('Complete package has multiple opponent branches', page.locator('.opening-branch-scope input').count() >= 2)
    ok('Board orientation is black', page.locator('.opening-board-stage [data-square]').first.get_attribute('data-square') == 'h1')
    for width, height in [(1500, 920), (1100, 700)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_timeout(120)
        bounds = page.locator('.opening-board-stage .board-container').bounding_box()
        print('Board bounds', width, height, bounds, flush=True)
        page.screenshot(path=str(out / f'layout-{width}.png'))
        ok(f'Board fits viewport at {width}x{height}', bounds['x'] >= 0 and bounds['y'] >= 0 and bounds['x'] + bounds['width'] <= width and bounds['y'] + bounds['height'] <= height - 8)
        ok(f'No outer page scroll at {width}x{height}', page.evaluate('document.documentElement.scrollHeight <= innerHeight + 1'))
    page.set_viewport_size({'width': 1500, 'height': 920})
    page.get_by_role('button', name='Lernen', exact=True).click()
    for step in range(3):
        page.locator('.opening-next-move strong').wait_for()
        page.wait_for_timeout(500)
        arrow = page.locator('.opening-board-stage .board-arrow[data-from][data-to]').first
        arrow.wait_for()
        source, target = arrow.get_attribute('data-from'), arrow.get_attribute('data-to')
        page.locator(f'.opening-board-stage [data-square="{source}"]').click()
        page.locator(f'.opening-board-stage [data-square="{target}"]').click()
        page.wait_for_timeout(500)
        ok(f'Learner black move {step + 1} accepted', page.locator('.opening-feedback.wrong').count() == 0)
    page.screenshot(path=str(out / 'response-training.png'))
    page.locator('.opening-favorites-section').get_by_role('button', name=re.compile('zum Repertoire hinzufügen')).click()
    page.get_by_role('button', name='Fokus beenden').click()
    saved = page.locator('.opening-favorite-list .opening-favorite-item').filter(has_text='Antworten:')
    saved.wait_for()
    ok('Starred response remains as reusable black repertoire after clearing focus', 'Schwarz' in saved.inner_text())
    saved.locator('.opening-repertoire-choice').click()
    ok('Saved response can be selected and trained', 'Antworten:' in page.locator('.opening-trainer-playerbar').inner_text())
    page.reload()
    page.get_by_role('button', name='Eröffnungen', exact=True).click()
    saved.wait_for()
    ok('Prepared package and favorite survive reload', 'Schwarz' in saved.inner_text())
    page.get_by_role('button', name='Fehler-Diagnostik', exact=True).click()
    panel.wait_for()
    panel.get_by_label('Eröffnungsphase bis Zug').select_option('15')
    page.wait_for_function('window.__opening.getSettings().openingWindowMoves===15')
    page.get_by_text('Nur deine eigenen Züge 1–15.', exact=False).wait_for()
    ok('Changing window recomputes opening stats and persists setting', '2 Fehler im Zugfenster' in panel.inner_text())
    ok('No uncaught UI errors', not errors)
    browser.close()
print(f'{len(checks)} opening UI checks passed.')
