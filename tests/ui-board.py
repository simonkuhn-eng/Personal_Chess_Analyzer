"""Real native mouse-drag regressions; local Vite, Python Playwright and Chrome."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

out = Path(__file__).resolve().parents[1] / 'tmp' / 'board-ui'
out.mkdir(parents=True, exist_ok=True)
html = '''<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
</script><script type="module" src="/tests/ui-board-fixture.jsx"></script></body></html>'''
results, errors = [], []

def ok(name, condition):
    assert condition, name
    results.append(name)
    print('OK', name, flush=True)

def square(page, name, flipped=False):
    file, rank = ord(name[0]) - ord('a'), int(name[1]) - 1
    return page.locator('.board-square').nth((rank if flipped else 7-rank)*8 + (7-file if flipped else file))

def drag(page, source, destination, flipped=False):
    start = square(page, source, flipped).locator('img.piece-svg').bounding_box()
    target = square(page, destination, flipped).bounding_box()
    x, y = start['x']+start['width']/2, start['y']+start['height']/2
    tx, ty = target['x']+target['width']/2, target['y']+target['height']/2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x+7, y+7, steps=3)
    page.mouse.move(tx, ty, steps=16)
    # Chromium needs a dragover event at the final target before mouseup.
    page.mouse.move(tx, ty)
    page.mouse.up()

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe', headless=True)
    def page_for(case, black=False):
        page = browser.new_page(viewport={'width':1550, 'height':950})
        page.set_default_timeout(8000)
        page.route('**/__board_fixes__?*', lambda route: route.fulfill(status=200, content_type='text/html', body=html))
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.goto('http://127.0.0.1:5173/__board_fixes__?case='+case+('&color=b' if black else ''))
        page.locator('.board-container').wait_for()
        return page

    capture = page_for('capture')
    square(capture, 'g1').click()
    drag(capture, 'e4', 'd5')
    ok('Drag capture uses dragged piece despite a different selection', capture.evaluate('window.__boardAudit.moves').copy() == ['e4d5'])
    capture.close()

    source = page_for('source')
    square(source, 'd1').click()
    drag(source, 'f4', 'd5')
    ok('Drag cannot move a previously selected piece to the same target', source.evaluate('window.__boardAudit.moves') == ['f4d5'])
    source.close()

    for black in [False, True]:
        rank = '8' if black else '1'
        for side, king_to, rook_from, rook_to in [('short','g','h','f'), ('long','c','a','d')]:
            for method in ['drag-target', 'drag-rook', 'click-target', 'click-rook']:
                page = page_for('castle', black)
                origin, target = 'e'+rank, (rook_from if method.endswith('rook') else king_to)+rank
                if method.startswith('drag'):
                    # Keep an unrelated rook selected to reproduce mixed click/drag use.
                    square(page, ('a' if side == 'short' else 'h')+rank, black).click()
                    drag(page, origin, target, black)
                else:
                    square(page, origin, black).click()
                    square(page, target, black).click()
                expected = origin+king_to+rank
                ok(f'Castle {"black" if black else "white"} {side} via {method}', page.evaluate('window.__boardAudit.moves') == [expected])
                ok(f'Castle rook follows {"black" if black else "white"} {side} {method}', square(page, rook_to+rank, black).locator('img[alt="'+('b' if black else 'w')+'R"]').count() == 1 and square(page, rook_from+rank, black).locator('img.piece-svg').count() == 0)
                page.close()

    for case in ['no-rights', 'through-check']:
        page = page_for(case)
        drag(page, 'e1', 'h1')
        square(page, 'e1').click()
        square(page, 'g1').click()
        ok('Illegal castle stays rejected: '+case, page.evaluate('window.__boardAudit.moves') == [])
        page.close()

    promotion = page_for('promotion')
    square(promotion, 'h1').click()
    drag(promotion, 'a7', 'b8')
    promotion.locator('.promotion-dialog').wait_for()
    ok('Drag capture promotion waits for explicit choice', promotion.evaluate('window.__boardAudit.moves') == [])
    promotion.get_by_title('Springer', exact=True).click()
    ok('Drag capture promotion preserves chosen knight', promotion.evaluate('window.__boardAudit.moves') == ['a7b8n'])
    promotion.close()

    ep = page_for('en-passant')
    square(ep, 'h1').click()
    drag(ep, 'e5', 'd6')
    ok('En passant capture via drag removes the captured pawn', ep.evaluate('window.__boardAudit.moves') == ['e5d6'] and square(ep, 'd5').locator('img.piece-svg').count() == 0)
    ep.close()

    opening = page_for('opening', True)
    moves = opening.evaluate('window.__boardAudit.branch')
    for ply in range(1, len(moves), 2):
        opening.locator('.board-container:not(.non-interactive)').wait_for()
        origin, target = moves[ply][:2], moves[ply][2:4]
        # A king click before dragging another piece mimics switching input styles.
        if origin != 'e8':
            square(opening, 'e8', True).click()
        drag(opening, origin, target, True)
        if ply+1 < len(moves):
            opening.get_by_text('Der Gegner zieht …', exact=True).wait_for(state='hidden')
    opening.get_by_text('Variante abgeschlossen.', exact=False).wait_for()
    ok('Full Caro-Kann Panov branch accepts drag captures and black castling', square(opening, 'g8', True).locator('img[alt="bK"]').count() == 1 and square(opening, 'f8', True).locator('img[alt="bR"]').count() == 1)
    opening.screenshot(path=str(out / 'caro-kann-castled.png'))
    opening.close()
    ok('No browser runtime errors', not errors)
    browser.close()

(out / 'results.json').write_text(json.dumps({'passed':results,'errors':errors},ensure_ascii=False,indent=2),encoding='utf-8')
print(f'{len(results)} board UI checks passed.', flush=True)
