"""Isolated UI regressions. Requires local Vite, Python Playwright and Chrome."""
from pathlib import Path
import json, re
from playwright.sync_api import sync_playwright

out = Path(__file__).resolve().parents[1] / 'tmp' / 'product-ui'
out.mkdir(parents=True, exist_ok=True)
html = '''<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
</script><script type="module" src="/tests/ui-product-fixture.jsx"></script></body></html>'''
results = []
errors = []
def ok(name, condition):
    assert condition, name
    results.append(name)
    print('OK', name, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe', headless=True)
    def page_for(case, width=1400, height=920):
        page = browser.new_page(viewport={'width': width, 'height': height})
        page.set_default_timeout(12000)
        page.route('**/__product_fixes__?*', lambda route: route.fulfill(status=200, content_type='text/html', body=html))
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.goto('http://127.0.0.1:5173/__product_fixes__?case=' + case)
        return page

    fresh = page_for('fresh')
    fresh.get_by_role('heading', name='Willkommen beim Personal Chess Analyzer').wait_for()
    ok('First run has own setup action and no foreign profile', fresh.get_by_role('button', name='Konten und Engine einrichten').count() == 1 and 'LegacyUser' not in fresh.locator('body').inner_text())
    for width, height in [(1400, 920), (1100, 700)]:
        fresh.set_viewport_size({'width': width, 'height': height})
        bounds = fresh.locator('.nav-links').evaluate('node=>[...node.querySelectorAll("button")].map(item=>{let r=item.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})')
        ok(f'All five tabs visible at {width}', len(bounds) == 5 and all(b['left'] >= 0 and b['right'] <= width and b['bottom'] <= 80 for b in bounds))
    fresh.screenshot(path=str(out / 'first-start.png'))
    fresh.close()

    modal = page_for('modal')
    modal.locator('textarea').fill('[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 *')
    modal.get_by_role('button', name=re.compile('Analyse starten')).click()
    modal.wait_for_function('window.__audit.waiting')
    modal.keyboard.press('Escape')
    modal.get_by_role('heading', name='Dialog geschlossen').wait_for()
    modal.evaluate('window.__audit.release()')
    modal.wait_for_timeout(250)
    ok('BUG-08: close cancels without completion callback', modal.evaluate('window.__audit.completed===0&&window.__audit.engineCalls===1'))
    modal.close()

    training = page_for('training', 1550, 950)
    training.locator('.board-container:not(.non-interactive)').wait_for()
    training.locator('.board-square').nth(48).click()
    training.locator('.board-square').nth(40).click()
    training.locator('.training-feedback.failure').wait_for()
    stored = training.evaluate('JSON.parse(localStorage.getItem("personal-chess-analyzer-reviews-v1:alice"))')
    ok('BUG-06: wrong answer saved before Next', stored['reviews']['audit_training:1']['lapses'] == 1)
    training.get_by_role('checkbox', name=re.compile('Leichte Fehler')).check()
    ok('BUG-06: filter change preserves original lapse', training.evaluate('JSON.parse(localStorage.getItem("personal-chess-analyzer-reviews-v1:alice")).reviews["audit_training:1"].lapses') == 1)
    training.get_by_role('button', name='Verlassen', exact=True).click()
    ok('BUG-06: leaving preserves exactly one lapse', training.evaluate('JSON.parse(localStorage.getItem("personal-chess-analyzer-reviews-v1:alice")).reviews["audit_training:1"].lapses') == 1)
    training.close()

    quota = page_for('quota', 1550, 950)
    quota.locator('.board-container:not(.non-interactive)').wait_for()
    quota.locator('.board-square').nth(52).click()
    quota.locator('.board-square').nth(36).click()
    quota.locator('.training-feedback.success').wait_for()
    ok('BUG-07: save failure does not promise next review', 'Nächste Wiederholung' not in quota.locator('.training-feedback.success').inner_text())
    quota.get_by_role('button', name='Erneut speichern', exact=True).wait_for()
    quota.screenshot(path=str(out / 'save-failure.png'))
    quota.evaluate('window.__audit.failQuota=false')
    quota.get_by_role('button', name='Erneut speichern', exact=True).click()
    quota.wait_for_function('!!localStorage.getItem("personal-chess-analyzer-reviews-v1:alice")')
    ok('BUG-07: retry persists original answer once', quota.evaluate('JSON.parse(localStorage.getItem("personal-chess-analyzer-reviews-v1:alice")).reviews["audit_training:1"].correct') == 1)
    quota.close()

    chance = page_for('chance')
    chance.locator('.training-deck-meta strong').wait_for()
    ok('Miss: card has one category and preserves evaluation loss', chance.locator('.training-deck-meta strong').inner_text() == 'Kf1 · Verpasste Chance' and chance.locator('.training-missed-opportunity').inner_text() == 'Materialgewinn' and '17.4%' in chance.locator('.training-deck-stats').inner_text())
    ok('Miss: filter counters are mutually exclusive', chance.locator('.training-quality-options small').all_text_contents() == ['0', '0', '0', '1'])
    chance.screenshot(path=str(out / 'exclusive-chance.png'))
    chance.get_by_role('checkbox', name=re.compile('Verpasste Chancen')).uncheck()
    ok('Miss: disabling chances removes card despite enabled mistakes', chance.locator('.training-deck-meta').count() == 0 and chance.get_by_role('checkbox', name=re.compile('Gröbere Fehler')).is_checked())
    chance.get_by_role('checkbox', name=re.compile('Verpasste Chancen')).check()
    chance.locator('.training-deck-meta strong').wait_for()
    ok('Miss: enabling chances returns exactly one card', chance.locator('.training-deck-meta strong').count() == 1 and '0/1 gemeistert' in chance.locator('.training-deck-count').inner_text())
    chance.close()

    chance_review = page_for('review-chance')
    chance_review.locator('.review-layout').wait_for()
    chance_review.get_by_role('button', name='Nächster Zug (Pfeil Rechts)', exact=True).click()
    chance_review.locator('.review-current-move .quality-pill').wait_for()
    ok('Miss: review has no additional severity badge', chance_review.locator('.review-current-move .quality-pill').count() == 1 and 'Verpasste Chance' in chance_review.locator('.review-current-move .quality-pill').inner_text())
    ok('Miss: evaluation graph uses the same category', chance_review.locator('.eval-chart-wrapper circle[data-quality="miss"]').count() == 1 and chance_review.locator('.eval-chart-wrapper circle[data-quality="mistake"]').count() == 0)
    chance_review.get_by_role('button', name=re.compile('Zugbewertungen')).click()
    counts = {quality: chance_review.locator(f'[data-quality-row="{quality}"] td').first.inner_text() for quality in ['mistake', 'blunder', 'miss']}
    ok('Miss: review summary counts the move only once', counts == {'mistake': '0', 'blunder': '0', 'miss': '1'})
    chance_review.close()

    review = page_for('review', 1400, 920)
    review.locator('.review-layout').wait_for()
    review.locator('.board-square').nth(52).click()
    review.locator('.board-square').nth(36).click()
    review.get_by_role('region', name='Variantenanalyse').wait_for()
    review.wait_for_function('window.__audit.contexts.some(x=>x.history.join(",")==="e2e4")')
    ok('Review: own move starts an independently evaluated branch', review.locator('.variation-moves').inner_text().find('e4') >= 0)
    review.locator('.board-square').nth(10).click()
    review.locator('.board-square').nth(26).click()
    review.get_by_role('button', name='Variante zurück', exact=True).click()
    review.locator('.board-square').nth(12).click()
    review.locator('.board-square').nth(28).click()
    ok('Review: new move replaces only future variation', 'e5' in review.locator('.variation-moves').inner_text() and 'c5' not in review.locator('.variation-moves').inner_text())
    review.get_by_role('button', name='Zur Partie zurück', exact=True).click()
    ok('Review: original starting board restored', review.locator('.board-square').nth(52).locator('img.piece-svg').count() == 1)
    review.get_by_role('button', name='Nächster Zug (Pfeil Rechts)', exact=True).click()
    review.get_by_role('button', name='Partiezug und Antwort prüfen', exact=True).click()
    review.get_by_role('region', name='Variantenanalyse').wait_for()
    review.keyboard.press('End')
    ok('Review: refutation can be stepped to checkmate', review.locator('.variation-moves').inner_text().find('Qh4#') >= 0)
    review.get_by_role('button', name='Zur Partie zurück', exact=True).click()
    review.locator('.board-square').nth(45).locator('img.piece-svg').wait_for()
    ok('Review: refutation return restores selected game move', review.locator('.board-square').nth(45).locator('img.piece-svg').count() == 1)
    review.get_by_role('button', name='Alternative vergleichen', exact=True).click()
    review.keyboard.press('End')
    review.wait_for_function('window.__audit.contexts.some(x=>x.history.join(",")==="e2e4,e7e5,g1f3,b8c6")')
    review.get_by_text('Stockfish rechnet...', exact=True).wait_for(state='hidden')
    ok('Review: alternative starts from same pre-move anchor', review.locator('.variation-moves').inner_text().find('e4') >= 0 and review.locator('.variation-moves').inner_text().find('Nc6') >= 0)
    review.screenshot(path=str(out / 'review-variation.png'))
    ok('Review: no archive or training mutation', review.evaluate('window.__audit.saved===0&&window.__audit.originalGame===window.__audit.getGame()') and review.evaluate('!Object.keys(localStorage).some(k=>k.includes("reviews-v1"))'))
    for width, height in [(1400, 920), (1100, 700)]:
        review.set_viewport_size({'width': width, 'height': height})
        ok(f'Review: no page overflow at {width}', review.evaluate('document.documentElement.scrollHeight<=innerHeight+1&&document.documentElement.scrollWidth<=innerWidth+1'))
    review.close()
    ok('No browser runtime errors', not errors)
    browser.close()

(out / 'results.json').write_text(json.dumps({'passed': results, 'errors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'{len(results)} UI checks passed.', flush=True)
