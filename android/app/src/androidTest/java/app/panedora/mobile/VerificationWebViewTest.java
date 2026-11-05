package app.panedora.mobile;

import android.content.Context;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Only local provider fixtures are used; no live CAPTCHA is automated. */
@RunWith(AndroidJUnit4.class)
public class VerificationWebViewTest {
    private WebView web;
    private boolean silent;
    private final AtomicInteger primary = new AtomicInteger(), alternate = new AtomicInteger();
    private static void ui(Runnable task) { InstrumentationRegistry.getInstrumentation().runOnMainSync(task); }
    private static WebResourceResponse response(int code,String body) {
        return new WebResourceResponse("application/javascript","UTF-8",code,code == 200 ? "OK" : "Not Found",
            Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }
    @Before public void createBrowser() {
        Context context = ApplicationProvider.getApplicationContext();
        ui(() -> {
            web = new WebView(context); web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true);
            web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false); web.layout(0,0,720,1280);
            CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web,true);
            web.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request) {
                    String url = request.getUrl().toString();
                    if (url.startsWith("https://www.pandora.com/Fixture/captcha")) { primary.incrementAndGet(); return response(silent ? 200 : 404,""); }
                    if (url.startsWith("https://captcha.px-cloud.net/PXFixture/captcha.js")) {
                        alternate.incrementAndGet();
                        return response(200,silent ? "" : """
                            const button = document.createElement('button'); button.id = 'fixture-complete';
                            button.textContent = 'Test verification fixture'; button.style.cssText = 'width:240px;height:70px';
                            button.onclick = () => {
                                document.cookie = '_px3=fixture-complete; Path=/; Secure; SameSite=Lax';
                                window._pxOnMobileCaptchaSuccess(true);
                            };
                            document.getElementById('px-captcha').appendChild(button);
                            """);
                    }
                    return response(404,""); // The test must never access Pandora or any external service.
                }
            });
        });
    }
    @After public void closeBrowser() { ui(() -> { if (web != null) { web.stopLoading(); web.destroy(); } }); }
    private String evaluate(String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
        ui(() -> web.evaluateJavascript(script,value -> { result.set(value); done.countDown(); }));
        assertTrue("WebView returned JavaScript result",done.await(5,TimeUnit.SECONDS)); return result.get();
    }
    private void state(String expected) throws Exception {
        long deadline = System.currentTimeMillis() + 20000;
        while (System.currentTimeMillis() < deadline) {
            if (evaluate(VerificationPage.stateScript("fixture-page")).equals(JSONObject.quote(expected))) return;
            Thread.sleep(100);
        }
        fail("Verification never reached " + expected);
    }
    private void load(int timeout) throws Exception {
        JSONObject challenge = new JSONObject("{\"errorCode\":1215,\"appId\":\"PXFixture\",\"uuid\":\"11111111-2222-3333-4444-555555555555\",\"jsClientSrc\":\"/Fixture/init.js\",\"hostUrl\":\"/Fixture/xhr\",\"blockScript\":\"/Fixture/captcha\",\"altBlockScript\":\"https://captcha.px-cloud.net/PXFixture/captcha.js\"}");
        String html = VerificationPage.html(403,challenge,"https://www.pandora.com/api/v1/auth/login","fixture-page",timeout,false);
        ui(() -> web.loadDataWithBaseURL(VerificationPage.ORIGIN + "/",html,"text/html","UTF-8",VerificationPage.ORIGIN + "/"));
    }
    @Test public void fallbackRendersAndMobileCompletionUsesTheSharedCookieJar() throws Exception {
        load(2000); state("ready"); assertEquals(1,primary.get()); assertEquals(1,alternate.get());
        assertEquals(JSONObject.quote(VerificationPage.ORIGIN),evaluate("window.origin"));
        evaluate("window._pxOnMobileCaptchaSuccess(false)"); state("ready");
        evaluate("document.getElementById('fixture-complete').click()"); state("complete");
        AtomicReference<String> cookies = new AtomicReference<>(); ui(() -> { CookieManager.getInstance().flush(); cookies.set(CookieManager.getInstance().getCookie(VerificationPage.ORIGIN)); });
        assertTrue(cookies.get().contains("_px3=fixture-complete"));
        assertEquals("\"loading\"",evaluate(VerificationPage.stateScript("stale-page")));
    }
    @Test public void aLoadedScriptThatNeverRendersShowsFailureInsteadOfWaitingForever() throws Exception {
        silent = true; load(250); state("failed");
        assertEquals(1,primary.get()); assertEquals(1,alternate.get());
        assertEquals("false",evaluate("document.getElementById('failure').hidden"));
    }
}
