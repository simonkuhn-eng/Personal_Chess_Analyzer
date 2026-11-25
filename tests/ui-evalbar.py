"""Targeted evaluation-bar hold check; does not run the complete UI suite."""
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
        page.route('**/__evalbar__?*',lambda route:route.fulfill(status=200,content_type='text/html',body=html))
        page.goto('http://127.0.0.1:5173/__evalbar__?case='+case)
        return page
    page=page_for('review-hold')
    page.wait_for_function('window.__audit.pendingEvals?.length===1')
    page.evaluate('window.__audit.pendingEvals[0](250)')
    page.locator('.eval-badge').get_by_text('+2.5',exact=True).wait_for()
    height=page.locator('.eval-bar-top').evaluate('node=>node.style.height')
    page.locator('.board-square').nth(52).click()
    page.locator('.board-square').nth(36).click()
    page.locator('.eval-bar-wrapper[data-evaluation-state="pending"]').wait_for()
    assert page.locator('.eval-badge').inner_text()=='+2.5'
    assert page.locator('.eval-bar-top').evaluate('node=>node.style.height')==height
    page.wait_for_function('window.__audit.pendingEvals.length===2')
    page.locator('.board-square').nth(10).click()
    page.locator('.board-square').nth(26).click()
    page.wait_for_function('window.__audit.pendingEvals.length===3')
    page.evaluate('window.__audit.pendingEvals[1](-800)')
    assert page.locator('.eval-badge').inner_text()=='+2.5','A stale position must not update the held bar'
    page.evaluate('window.__audit.pendingEvals[2](-180)')
    page.locator('.eval-badge').get_by_text('-1.8',exact=True).wait_for()
    page.locator('.board-square').nth(62).click()
    page.locator('.board-square').nth(45).click()
    page.wait_for_function('window.__audit.pendingEvals.length===4')
    assert page.locator('.eval-badge').inner_text()=='-1.8'
    page.evaluate('window.__audit.pendingEvals[3](0)')
    page.locator('.eval-badge').get_by_text('+0.0',exact=True).wait_for()
    page.close()
    page=page_for('evalbar')
    page.locator('.eval-badge').get_by_text('+1.8',exact=True).wait_for()
    page.evaluate('window.__audit.setBar({scoreCp:0,unavailable:true,resetKey:"second"})')
    page.locator('.eval-badge').get_by_text('…',exact=True).wait_for()
    page.evaluate('window.__audit.setBar({scoreCp:-100000,mate:-3,resetKey:"second"})')
    page.locator('.eval-badge').get_by_text('-M3',exact=True).wait_for()
    page.evaluate('window.__audit.setBar({scoreCp:0,unavailable:true,resetKey:"second",isFlipped:true})')
    page.locator('.eval-bar-wrapper[data-evaluation-state="pending"]').wait_for()
    assert page.locator('.eval-badge').inner_text()=='-M3'
    page.evaluate('window.__audit.setBar({scoreCp:0,resetKey:"second"})')
    page.locator('.eval-badge').get_by_text('+0.0',exact=True).wait_for()
    assert not errors,errors
    print('Eval bar: held score/height, stale reply ignored, new zero accepted, game reset and held mate passed.')
    browser.close()
