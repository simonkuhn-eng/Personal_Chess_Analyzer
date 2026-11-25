"""Focused startup/tab smoke check only; no full UI regression run."""
from playwright.sync_api import sync_playwright
html='''<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
</script><script type="module" src="/tests/ui-product-fixture.jsx"></script></body></html>'''
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',headless=True)
    page=browser.new_page(viewport={'width':1400,'height':920})
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/__startup__?*',lambda route:route.fulfill(status=200,content_type='text/html',body=html))
    page.goto('http://127.0.0.1:5173/__startup__?case=review')
    page.locator('.review-layout').wait_for()
    assert page.evaluate('window.__audit.statsCalls')==0, 'Startup must not calculate full diagnostics'
    page.get_by_role('button',name='Fehler-Diagnostik',exact=True).click()
    page.get_by_role('heading',name='Noch keine Analyse-Daten verfügbar').wait_for()
    assert page.evaluate('window.__audit.statsCalls')==1
    page.get_by_role('button',name='Partie Review',exact=True).click()
    page.locator('.review-layout').wait_for()
    page.get_by_role('button',name='Fehler-Diagnostik',exact=True).click()
    page.get_by_role('heading',name='Noch keine Analyse-Daten verfügbar').wait_for()
    assert page.evaluate('window.__audit.statsCalls')==1, 'Returning to diagnostics reuses current stats'
    page.get_by_role('button',name='Eröffnungen',exact=True).click()
    page.get_by_role('heading',name='Eröffnungsrepertoire',exact=True).wait_for()
    assert not errors, errors
    print('Startup smoke: review without diagnostics, on-demand diagnostics, cached return and lazy opening tab passed.')
    browser.close()
