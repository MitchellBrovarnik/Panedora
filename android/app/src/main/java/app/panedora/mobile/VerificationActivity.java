package app.panedora.mobile;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import java.util.UUID;

/** Displays the original challenge for the user; completion only retries the server request. */
@androidx.media3.common.util.UnstableApi
public final class VerificationActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web;
    private FrameLayout container;
    private TextView status;
    private AppModel model;
    private PandoraClient.ApiException challenge;
    private boolean finished, alternateFirst, widgetReady, loadFailed;
    private int generation;
    private String pageId;

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); WindowCompat.setDecorFitsSystemWindows(getWindow(),false);
        model = AppModel.get(this); challenge = model.verification;
        if (challenge == null) { finish(); return; }
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(16,16,22));
        ViewCompat.setOnApplyWindowInsetsListener(root,(view,insets) -> {
            var padding = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(padding.left,padding.top,padding.right,padding.bottom); return insets;
        });
        TextView title = new TextView(this); title.setId(R.id.verification_title);
        title.setText("Pandora verification"); title.setTextColor(0xffeeedf3); title.setTextSize(20); title.setPadding(dp(20),dp(16),dp(20),dp(12)); root.addView(title);
        status = new TextView(this); status.setId(R.id.verification_status); status.setTextColor(0xffbdb9cd); status.setTextSize(14);
        status.setPadding(dp(20),0,dp(20),dp(12)); status.setAccessibilityLiveRegion(android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(status);
        container = new FrameLayout(this); root.addView(container,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout actions = new LinearLayout(this); actions.setPadding(dp(12),dp(8),dp(12),dp(12));
        Button reload = new Button(this); reload.setText("Reload check"); reload.setAllCaps(false); reload.setId(R.id.verification_reload);
        reload.setOnClickListener(v -> { alternateFirst = !alternateFirst; loadPage(); });
        Button cancel = new Button(this); cancel.setText("Cancel"); cancel.setAllCaps(false); cancel.setOnClickListener(v -> finish());
        actions.addView(reload,new LinearLayout.LayoutParams(0,dp(52),1)); actions.addView(cancel,new LinearLayout.LayoutParams(0,dp(52),1)); root.addView(actions);
        setContentView(root); ViewCompat.requestApplyInsets(root); loadPage();
    }
    private void failed() {
        if (!finished && !loadFailed) { loadFailed = true; status.setText("Pandora’s check could not load. Tap Reload check to try again."); status.setTextColor(0xfff0b7b7); }
    }
    private void loadPage() {
        int request = ++generation; handler.removeCallbacksAndMessages(null); pageId = UUID.randomUUID().toString(); widgetReady = loadFailed = false;
        String html;
        try { html = VerificationPage.html(challenge.status,challenge.details,challenge.blockedUrl,pageId,12000,alternateFirst); }
        catch (Exception e) { failed(); return; }
        if (web != null) { container.removeView(web); web.stopLoading(); web.destroy(); }
        web = new WebView(this); web.setId(R.id.verification_web); container.addView(web,new FrameLayout.LayoutParams(-1,-1)); web.setBackgroundColor(0xff101016);
        WebSettings settings = web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (model.api instanceof PandoraClient client) settings.setUserAgentString(client.userAgent);
        CookieManager.getInstance().setAcceptCookie(true);
        // HUMAN may render its own cross-site frame. Its cookies remain in the API's shared jar.
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest resource) {
                return resource.isForMainFrame() && !VerificationPage.pandoraUrl(resource.getUrl().toString());
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest resource,WebResourceError error) {
                if (request == generation && resource.isForMainFrame()) failed();
            }
            @Override public boolean onRenderProcessGone(WebView view,RenderProcessGoneDetail detail) {
                if (web == view) { container.removeView(view); view.destroy(); web = null; failed(); }
                return true;
            }
        });
        status.setText("Loading Pandora’s verification check…"); status.setTextColor(0xffbdb9cd);
        // A clean document avoids the site's existing sensor/app scripts and CSP.
        // No credentials, native JavaScript bridge, or automatic challenge interaction.
        web.loadDataWithBaseURL(VerificationPage.ORIGIN + "/",html,"text/html","UTF-8",VerificationPage.ORIGIN + "/");
        handler.postDelayed(() -> poll(request),250);
        handler.postDelayed(() -> { if (!finished && request == generation && !widgetReady) failed(); },30000);
    }
    private void poll(int request) {
        if (finished || request != generation || web == null) return;
        web.evaluateJavascript(VerificationPage.stateScript(pageId),result -> {
            if (finished || request != generation) return;
            if ("\"complete\"".equals(result)) {
                finished = true; CookieManager.getInstance().flush(); model.verified(); finish(); return;
            }
            if ("\"failed\"".equals(result)) failed();
            if ("\"ready\"".equals(result) && (!widgetReady || loadFailed)) {
                widgetReady = true; loadFailed = false; status.setTextColor(0xffbdb9cd);
                status.setText("Complete the check below. Sign-in will retry when Pandora accepts it.");
            }
            handler.postDelayed(() -> poll(request),250);
        });
    }
    @Override protected void onDestroy() {
        finished = true; ++generation; handler.removeCallbacksAndMessages(null);
        if (web != null) { container.removeView(web); web.stopLoading(); web.destroy(); web = null; }
        super.onDestroy();
    }
}
