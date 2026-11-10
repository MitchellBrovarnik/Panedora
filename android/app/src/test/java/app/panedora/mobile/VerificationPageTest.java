package app.panedora.mobile;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class VerificationPageTest {
    static JSONObject challenge() throws Exception {
        return new JSONObject("{\"errorCode\":1215,\"appId\":\"PXFixture\",\"uuid\":\"11111111-2222-3333-4444-555555555555\",\"jsClientSrc\":\"/Fixture/init.js\",\"hostUrl\":\"/Fixture/xhr\",\"blockScript\":\"/Fixture/captcha?a=c\"}");
    }
    @Test public void cleanDocumentWiresBothCompletionCallbacksAndEscapesData() throws Exception {
        JSONObject challenge = challenge().put("vid","</script><script>bad()</script>").put("altBlockScript",JSONObject.NULL);
        String html = VerificationPage.html(403,challenge,"https://www.pandora.com/api/v1/auth/login","page-1",12000,false);
        assertTrue(html.startsWith("<!doctype html>")); assertTrue(html.contains("_pxOnMobileCaptchaSuccess = complete"));
        assertTrue(html.contains("_pxOnCaptchaSuccess = complete")); assertFalse(html.contains("<script>bad()"));
        assertFalse(html.contains("document.body.innerHTML")); assertTrue(html.contains("script.onerror"));
        assertTrue(VerificationPage.stateScript("page-1").contains("panedoraPage"));
    }
    @Test public void rejectsUntrustedChallengeResourcesAndOrigins() throws Exception {
        assertFalse(VerificationPage.pandoraUrl("https://www.pandora.com.evil.invalid/"));
        assertFalse(VerificationPage.pandoraUrl("http://www.pandora.com/"));
        for (String field : new String[]{"jsClientSrc","hostUrl","blockScript","altBlockScript"}) {
            JSONObject bad = challenge().put(field,"https://evil.invalid/anything");
            assertThrows(Exception.class,() -> VerificationPage.html(403,bad,"https://www.pandora.com/api/v1/auth/login","page-1",1000,false));
        }
        JSONObject alternate = challenge().put("altBlockScript","https://captcha.px-cloud.net:444/PXFixture/captcha.js");
        assertThrows(Exception.class,() -> VerificationPage.html(403,alternate,"https://www.pandora.com/api/v1/auth/login","page-1",1000,false));
        assertThrows(Exception.class,() -> VerificationPage.html(200,challenge(),"https://www.pandora.com/","page-1",1000,false));
    }
}
