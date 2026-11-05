package app.panedora.mobile;

import org.json.JSONObject;
import java.net.URI;

/** A fresh document for the original, user-completed Pandora challenge. */
final class VerificationPage {
    static final String ORIGIN = "https://www.pandora.com";
    static boolean pandoraUrl(String value) {
        try { URI uri = new URI(value); return "https".equals(uri.getScheme()) && "www.pandora.com".equals(uri.getHost()) && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443); }
        catch (Exception ignored) { return false; }
    }
    private static String resource(JSONObject source,String field,String path) throws Exception {
        String value = source.getString(field), absolute = value.startsWith("/") ? ORIGIN + value : value;
        if (!pandoraUrl(absolute) || !new URI(absolute).getPath().equals(path)) throw new Exception("Unexpected Pandora verification address.");
        return absolute;
    }
    static String html(int status,JSONObject source,String blockedUrl,String pageId,int timeoutMillis,boolean alternateFirst) throws Exception {
        String appId = source.getString("appId"), uuid = source.getString("uuid");
        if (status != 403 || source.optInt("errorCode") != 1215 || !appId.matches("PX[a-zA-Z0-9]{1,32}") ||
            !uuid.matches("(?i)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}") || !pandoraUrl(blockedUrl) || !pageId.matches("[a-zA-Z0-9-]{1,64}")) throw new Exception("Invalid Pandora verification response.");
        String prefix = "/" + appId.substring(2);
        JSONObject data = PandoraProtocol.body("appId",appId,"uuid",uuid,"vid",source.opt("vid"),"blockedUrl",blockedUrl,
            "firstPartyEnabled",source.optBoolean("firstPartyEnabled"),"jsClientSrc",resource(source,"jsClientSrc",prefix + "/init.js"),
            "hostUrl",resource(source,"hostUrl",prefix + "/xhr"),"blockScript",resource(source,"blockScript",prefix + "/captcha"),
            "pageId",pageId,"timeout",Math.max(250,Math.min(20000,timeoutMillis)),"alternateFirst",alternateFirst);
        String alternate = source.isNull("altBlockScript") ? "" : source.optString("altBlockScript");
        if (!alternate.isEmpty()) {
            URI uri = new URI(alternate);
            if (!"https".equals(uri.getScheme()) || !"captcha.px-cloud.net".equals(uri.getHost()) || uri.getUserInfo() != null ||
                (uri.getPort() != -1 && uri.getPort() != 443) || !uri.getPath().equals("/" + appId + "/captcha.js")) throw new Exception("Unexpected verification fallback.");
            data.put("alternate",alternate);
        }
        return """
            <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>Pandora verification</title><style>
            html,body{margin:0;background:#101016;color:#eeedf3;font:16px system-ui;}
            main{box-sizing:border-box;padding:28px 16px;text-align:center;width:100%;}
            h1{font-size:24px;margin:0 0 16px;}p{line-height:1.5;color:#bdb9cd;}
            #px-captcha{max-width:100%;margin:24px auto;}#failure{color:#f0b7b7;}
            </style></head><body><main><h1>Verify with Pandora</h1>
            <p>Complete the check below to continue signing in.</p><div id="px-captcha"></div>
            <p id="failure" hidden>The check could not load. Use Reload check below to try again.</p></main><script>
            (() => { const c =
            """ + data.toString().replace("<","\\u003c") + ";" + """
                const root = document.documentElement, box = document.getElementById('px-captcha');
                root.dataset.panedoraPage = c.pageId; root.dataset.panedoraVerification = 'loading';
                window._pxMonitorAbr = false; window._pxBlockedUrl = c.blockedUrl;
                window._pxAppId = c.appId; window._pxJsClientSrc = c.jsClientSrc;
                window._pxFirstPartyEnabled = c.firstPartyEnabled;
                window._pxVid = c.vid; window._pxUuid = c.uuid; window._pxHostUrl = c.hostUrl;
                let timer, watcher, attempt = 0;
                const complete = valid => {
                    if (valid !== true) return;
                    clearTimeout(timer); clearInterval(watcher); root.dataset.panedoraVerification = 'complete';
                };
                window._pxOnCaptchaSuccess = complete;
                window._pxOnMobileCaptchaSuccess = complete;
                const rendered = () => [...box.querySelectorAll('iframe,button,input,[role="button"],canvas')].some(element => {
                    const bounds = element.getBoundingClientRect(); return bounds.width > 4 && bounds.height > 4;
                });
                const sources = [{url:c.blockScript,route:'pandora'}]; if (c.alternate) sources.push({url:c.alternate,route:'provider'});
                if (c.alternateFirst) sources.reverse();
                const load = index => {
                    if (root.dataset.panedoraVerification === 'complete') return;
                    clearTimeout(timer); const generation = ++attempt;
                    if (index >= sources.length) {
                        clearInterval(watcher); root.dataset.panedoraVerification = 'failed';
                        document.getElementById('failure').hidden = false; return;
                    }
                    root.dataset.panedoraRoute = sources[index].route;
                    const script = document.createElement('script'); script.src = sources[index].url;
                    const fallback = () => {
                        if (generation !== attempt || root.dataset.panedoraVerification === 'complete' || rendered()) return;
                        script.remove(); load(index + 1);
                    };
                    script.onerror = fallback;
                    timer = setTimeout(fallback,c.timeout); document.head.appendChild(script);
                };
                watcher = setInterval(() => {
                    if (root.dataset.panedoraVerification === 'loading' && rendered()) {
                        root.dataset.panedoraVerification = 'ready'; clearTimeout(timer);
                    }
                },100);
                load(0);
            })();
            </script></body></html>
            """;
    }
    static String stateScript(String pageId) {
        return "(() => {const e=document.documentElement;return window.origin==='" + ORIGIN + "' && e.dataset.panedoraPage===" + JSONObject.quote(pageId) + " ? e.dataset.panedoraVerification : 'loading';})()";
    }
    static String routeScript(String pageId) {
        return "(() => {const e=document.documentElement;return window.origin==='" + ORIGIN + "' && e.dataset.panedoraPage===" + JSONObject.quote(pageId) + " && ['ready','complete'].includes(e.dataset.panedoraVerification) ? e.dataset.panedoraRoute : '';})()";
    }
}
