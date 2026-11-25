"""Focused latest-game import smoke; local Vite, Playwright and Chrome."""
from pathlib import Path
from playwright.sync_api import sync_playwright
html='''<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
</script><script type="module" src="/tests/ui-product-fixture.jsx"></script></body></html>'''
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True)
    errors=[]
    def page_for(case):
        page=browser.new_page(viewport={'width':1400,'height':920})
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.route('**/__latest__?*',lambda route:route.fulfill(status=200,content_type='text/html',body=html))
        page.goto('http://127.0.0.1:5173/__latest__?case='+case)
        return page
    page=page_for('fresh')
    page.get_by_role('button',name='Neue Partie laden',exact=True).click()
    page.get_by_role('dialog',name='Partien laden',exact=True).wait_for()
    page.get_by_role('button',name='Nur letzte Partie laden',exact=True).wait_for()
    out=Path('tmp/latest-ui');out.mkdir(parents=True,exist_ok=True)
    page.screenshot(path=str(out/'dialog.png'))
    page.close()
    page=page_for('latest')
    page.get_by_role('button',name='Nur letzte Partie laden',exact=True).click()
    page.get_by_role('heading',name='Dialog geschlossen').wait_for()
    assert page.evaluate('window.__audit.latestCalls===1&&window.__audit.completed===1&&window.__audit.loadedGame.moves.length===2&&window.__audit.loadedGame.timeClass==="blitz"')
    page.close()
    page=page_for('latest-existing')
    page.get_by_role('button',name='Nur letzte Partie laden',exact=True).click()
    page.get_by_role('heading',name='Dialog geschlossen').wait_for()
    assert page.evaluate('window.__audit.opened.length===1&&window.__audit.engineCalls===0&&window.__audit.completed===0&&window.__audit.saved===0')
    page.close()
    page=page_for('latest-cancel')
    page.get_by_role('button',name='Nur letzte Partie laden',exact=True).click()
    page.wait_for_function('window.__audit.waiting')
    page.keyboard.press('Escape')
    page.get_by_role('heading',name='Dialog geschlossen').wait_for()
    page.evaluate('window.__audit.release()')
    page.wait_for_timeout(100)
    assert page.evaluate('window.__audit.completed===0&&window.__audit.engineCalls===1')
    assert not errors,errors
    print('Latest-game UI: renamed action, exactly one analysis, existing analysis reused and cancellation passed.')
    browser.close()
