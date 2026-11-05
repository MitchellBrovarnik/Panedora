package app.panedora.mobile;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Exercises the real REST client, auth headers, and expiry retry with in-memory HTTP. */
@RunWith(AndroidJUnit4.class)
public class PandoraSessionTest {
    private final Context context=ApplicationProvider.getApplicationContext();
    private CredentialStore credentials;
    private PandoraClient client;
    private SessionServer server;
    private static final class Call {
        final String path, auth;
        Call(String path,String auth) { this.path=path; this.auth=auth; }
    }
    private static final class SessionServer implements PandoraClient.ConnectionFactory {
        final List<Call> calls=new ArrayList<>();
        int logins, setters;
        long mode;
        boolean expireSetter;
        String renewedBranding="PandoraPremium", owner;
        JSONObject modes() throws Exception {
            return new JSONObject().put("interactiveRadioAvailable",true).put("currentModeId",mode).put("availableModes",new JSONArray()
                .put(new JSONObject().put("modeId",0).put("modeName","My Station").put("isModeAvailable",true))
                .put(new JSONObject().put("modeId",5).put("modeName","Artist Only").put("isModeAvailable",true)));
        }
        @Override public HttpURLConnection open(URL url) {
            return new HttpURLConnection(url) {
                final ByteArrayOutputStream request=new ByteArrayOutputStream();
                byte[] reply;
                @Override public OutputStream getOutputStream() { return request; }
                @Override public int getResponseCode() throws IOException {
                    if (reply!=null) return responseCode;
                    try {
                        JSONObject body=new JSONObject(request.toString(StandardCharsets.UTF_8.name())), response;
                        String path=url.getPath(), auth=getRequestProperty("X-AuthToken"); calls.add(new Call(path,auth)); responseCode=200;
                        if (path.endsWith("/auth/login")) {
                            logins++; response=new JSONObject().put("authToken","session-"+logins).put("config",new JSONObject()
                                .put("branding",logins==1 ? "PandoraPremium" : renewedBranding).put("flags",new JSONArray().put("onDemand")));
                        } else if (path.endsWith("/playbackResumed")) {
                            if (owner!=null && !owner.equals(auth) && !body.optBoolean("forceActive")) response=new JSONObject().put("errorString","STREAM_VIOLATION");
                            else { owner=auth; response=new JSONObject(); }
                        } else if (path.endsWith("/getAvailableModesSimple")) response=modes();
                        else if (path.endsWith("/setAndGetAvailableModes")) {
                            setters++;
                            if (expireSetter) { expireSetter=false; responseCode=401; response=new JSONObject().put("errorCode",1000); }
                            else if (owner!=null && !owner.equals(auth)) response=new JSONObject().put("errorString","STREAM_VIOLATION");
                            else { mode=body.getLong("modeId"); response=modes(); }
                        } else throw new AssertionError("Unexpected endpoint: "+path);
                        reply=response.toString().getBytes(StandardCharsets.UTF_8); return responseCode;
                    } catch (Exception error) { throw new IOException(error); }
                }
                @Override public Map<String,List<String>> getHeaderFields() { return Collections.emptyMap(); }
                @Override public InputStream getInputStream() throws IOException { getResponseCode(); return new ByteArrayInputStream(reply); }
                @Override public InputStream getErrorStream() { return new ByteArrayInputStream(reply==null ? new byte[0] : reply); }
                @Override public void connect() {}
                @Override public void disconnect() {}
                @Override public boolean usingProxy() { return false; }
            };
        }
    }
    @Before public void prepare() throws Exception {
        credentials=new CredentialStore(context); credentials.save("fixture@example.invalid","fixture-password"); server=new SessionServer();
        AtomicReference<PandoraClient> result=new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> result.set(new PandoraClient(context,credentials,server))); client=result.get();
        client.login("fixture@example.invalid","fixture-password");
    }
    @After public void clear() { if (client!=null) client.clear(); if (credentials!=null) credentials.clear(); }
    @Test public void artistOnlyReusesTheVerifiedPlayingSessionWithoutSigningInAgain() throws Exception {
        client.resume(false); assertTrue(client.setStationMode("station",5,() -> true).active(5));
        assertEquals("Artist Only must not create a competing session",1,server.logins); assertEquals(1,server.setters);
        for (Call call:server.calls) if (!call.path.endsWith("/auth/login")) assertEquals("session-1",call.auth);
        assertEquals("session-1",server.owner);
    }
    @Test public void anExpiredTokenCannotRetryAPremiumModeAfterTheAccountBecamePlus() throws Exception {
        server.expireSetter=true; server.renewedBranding="PandoraPlus";
        Exception error=assertThrows(Exception.class,() -> client.setStationMode("station",5,() -> true));
        assertTrue(error.getMessage().contains("Premium")); assertEquals(2,server.logins);
        assertEquals("The setter is not retried with a Plus token",1,server.setters); assertEquals(0,server.mode);
        assertFalse(client.stationModes("station").find(5).available);
    }
    @Test public void genuineExpiryCanRetryOnlyAfterANewPremiumLoginProvesEligibility() throws Exception {
        server.expireSetter=true;
        assertTrue(client.setStationMode("station",5,() -> true).active(5));
        assertEquals(2,server.logins); assertEquals(2,server.setters);
        assertEquals("session-2",server.calls.get(server.calls.size()-1).auth);
    }
}
