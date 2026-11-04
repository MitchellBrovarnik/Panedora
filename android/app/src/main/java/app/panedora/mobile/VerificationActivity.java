package app.panedora.mobile;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.net.URI;

/** Shows Pandora's own challenge for the user. Never solves or skips verification. */
@androidx.media3.common.util.UnstableApi
public final class VerificationActivity extends Activity {
    private WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean injected, finished;
    private AppModel model;
    private String script;
    static boolean pandoraUrl(String value) {
        try { URI uri = new URI(value); return "https".equals(uri.getScheme()) && "www.pandora.com".equals(uri.getHost()) && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443); }
        catch (Exception ignored) { return false; }
    }
    private static String resource(JSONObject response, String field, String expected) throws Exception {
        String value = response.getString(field);
        String absolute = value.startsWith("/") ? PandoraClient.ORIGIN + value : value;
        if (!pandoraUrl(absolute) || !new URI(absolute).getPath().equals(expected)) throw new Exception("Unexpected Pandora verification address.");
        return absolute;
    }
    static String challengeScript(PandoraClient.ApiException error) throws Exception {
        JSONObject source = error.details;
        String appId = source.getString("appId"), uuid = source.getString("uuid");
        if (!error.verification() || !appId.matches("PX[a-zA-Z0-9]{1,32}") || !uuid.matches("(?i)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}") || !pandoraUrl(error.blockedUrl)) throw new Exception("Invalid Pandora verification response.");
        String prefix = "/" + appId.substring(2);
        JSONObject data = PandoraProtocol.body("appId", appId, "uuid", uuid, "vid", source.optString("vid"),
            "blockedUrl", error.blockedUrl, "firstPartyEnabled", source.optBoolean("firstPartyEnabled"),
            "jsClientSrc", resource(source, "jsClientSrc", prefix + "/init.js"),
            "hostUrl", resource(source, "hostUrl", prefix + "/xhr"),
            "blockScript", resource(source, "blockScript", prefix + "/captcha"));
        String alternate = source.optString("altBlockScript");
        if (!alternate.isEmpty()) {
            URI uri = new URI(alternate);
            if (!"https".equals(uri.getScheme()) || !"captcha.px-cloud.net".equals(uri.getHost()) || uri.getUserInfo() != null || !uri.getPath().equals("/" + appId + "/captcha.js")) throw new Exception("Unexpected verification fallback.");
            data.put("alternate", alternate);
        }
        return "(() => { const c = " + data.toString().replace("<", "\\u003c") + ";" + """
            window._pxMonitorAbr = false; window._pxBlockedUrl = c.blockedUrl;
            window._pxAppId = c.appId; window._pxJsClientSrc = c.jsClientSrc;
            window._pxFirstPartyEnabled = c.firstPartyEnabled;
            window._pxVid = c.vid; window._pxUuid = c.uuid; window._pxHostUrl = c.hostUrl;
            window._pxOnCaptchaSuccess = valid => { if (valid === true) document.documentElement.dataset.panedoraVerified = 'true'; };
            document.documentElement.dataset.panedoraVerified = 'false';
            document.body.innerHTML = '<main style="position:fixed;inset:0;z-index:2147483647;overflow:auto;background:#101016;color:#eeedf3;font:16px system-ui;padding:28px 12px;text-align:center"><h2>Verify with Pandora</h2><p>Complete the check below to continue signing in.</p><div id="px-captcha"></div><p id="load-error" hidden>The check could not load. Close this screen and try again.</p></main>';
            const load = (url, retry) => {
                const s = document.createElement('script'); s.src = url;
                s.onerror = () => { if (retry && c.alternate) load(c.alternate, false); else document.getElementById('load-error').hidden = false; };
                document.head.appendChild(s);
            };
            load(c.blockScript, true);
            })();
            """;
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); model = AppModel.get(this);
        try { if (model.verification == null) { finish(); return; } script = challengeScript(model.verification); }
        catch (Exception e) { model.message = e.getMessage(); model.changed(); finish(); return; }
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(16,16,22));
        root.setPadding(0, 40, 0, 24);
        TextView title = new TextView(this); title.setText("Pandora verification"); title.setTextColor(Color.WHITE); title.setTextSize(20); title.setPadding(20,16,20,16); root.addView(title);
        web = new WebView(this); root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        Button close = new Button(this); close.setText("Cancel verification"); close.setOnClickListener(v -> finish()); root.addView(close);
        setContentView(root);
        web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request.isForMainFrame() && !pandoraUrl(request.getUrl().toString());
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (injected || !pandoraUrl(url) || finished) return;
                injected = true; view.evaluateJavascript(script, ignored -> poll());
            }
        });
        web.loadUrl(PandoraClient.ORIGIN + "/");
    }
    private void poll() {
        if (finished || web == null || !pandoraUrl(web.getUrl())) return;
        web.evaluateJavascript("document.documentElement.dataset.panedoraVerified === 'true'", result -> {
            if (finished) return;
            if ("true".equals(result)) { finished = true; CookieManager.getInstance().flush(); model.verified(); finish(); }
            else handler.postDelayed(this::poll, 500);
        });
    }
    @Override protected void onDestroy() {
        finished = true; handler.removeCallbacksAndMessages(null);
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        super.onDestroy();
    }
}
