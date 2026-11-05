package app.panedora.mobile;

import android.content.Context;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.List;

final class PandoraClient implements PandoraGateway {
    static final String ORIGIN = "https://www.pandora.com";
    static final class ApiException extends Exception {
        final int status, code;
        final JSONObject details;
        final String blockedUrl;
        ApiException(int status, JSONObject details, String url) {
            super(message(status, details)); this.status = status; this.code = details.optInt("errorCode"); this.details = details; this.blockedUrl = url;
        }
        boolean verification() { return status == 403 && code == 1215; }
        boolean conflict() { return PandoraProtocol.conflict(details); }
        boolean expired() { return status == 401 || code == 1000; }
        private static String message(int status, JSONObject value) {
            if (PandoraProtocol.conflict(value)) return "Pandora is playing on another device.";
            if (status == 403 && value.optInt("errorCode") == 1215) return "Pandora needs a verification check. Tap Verify with Pandora.";
            if (status == 401 || value.optInt("errorCode") == 1000) return "Your Pandora session expired. Please sign in again.";
            String text = value.optString("message", value.optString("errorString", ""));
            return text.isEmpty() || text.length() > 160 ? "Pandora could not complete the request (" + status + "). Please try again." : text;
        }
    }
    private final CookieManager cookies = CookieManager.getInstance();
    private final CredentialStore credentials;
    final String userAgent;
    private String authToken;
    PandoraClient(Context context, CredentialStore credentials) {
        this.credentials = credentials; userAgent = WebSettings.getDefaultUserAgent(context);
        cookies.setAcceptCookie(true);
    }
    private JSONObject request(String endpoint, JSONObject body) throws Exception {
        try { return send(endpoint, body); }
        catch (ApiException e) {
            if (endpoint.equals("/v1/auth/login") || !e.expired()) throw e;
            JSONObject saved = credentials.read(); if (saved == null) throw e;
            login(saved.getString("email"), saved.getString("password"));
            return send(endpoint, body); // One refresh, then surface failure to the user.
        }
    }
    private JSONObject send(String endpoint, JSONObject body) throws Exception {
        String url = ORIGIN + "/api" + endpoint;
        String jar = cookies.getCookie(url); if (jar == null) jar = "";
        String csrf = "";
        // CookieManager orders matching cookies by path; prefer the API-scoped token.
        for (String entry : jar.split(";")) if (entry.trim().startsWith("csrftoken=")) { csrf = entry.trim().substring(10); break; }
        if (csrf.isEmpty()) {
            byte[] bytes = new byte[16]; new SecureRandom().nextBytes(bytes);
            StringBuilder hex = new StringBuilder(); for (byte b : bytes) hex.append(String.format("%02x", b & 255)); csrf = hex.toString();
            cookies.setCookie(ORIGIN, "csrftoken=" + csrf + "; Path=/; Domain=.pandora.com; Secure", null);
            jar += (jar.isEmpty() ? "" : "; ") + "csrftoken=" + csrf;
        }
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(20000); connection.setReadTimeout(20000); connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod("POST"); connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", "application/json, text/plain, */*");
        connection.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
        connection.setRequestProperty("User-Agent", userAgent);
        connection.setRequestProperty("Origin", ORIGIN); connection.setRequestProperty("Referer", ORIGIN + "/");
        connection.setRequestProperty("Cookie", jar); connection.setRequestProperty("X-CsrfToken", csrf);
        if (!endpoint.equals("/v1/auth/login") && authToken != null) connection.setRequestProperty("X-AuthToken", authToken);
        try {
            try (var out = connection.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int status = connection.getResponseCode();
            for (var header : connection.getHeaderFields().entrySet()) {
                if ("Set-Cookie".equalsIgnoreCase(header.getKey())) for (String value : header.getValue()) cookies.setCookie(url, value, null);
            }
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            JSONObject response;
            try (InputStream input = stream; ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
                if (input != null) {
                    byte[] data = new byte[8192]; int count;
                    while ((count = input.read(data)) != -1) { buffer.write(data, 0, count); if (buffer.size() > 2_000_000) throw new Exception("Pandora returned an unexpectedly large response."); }
                }
                try { response = new JSONObject(buffer.toString(StandardCharsets.UTF_8.name())); }
                catch (Exception invalid) { throw new Exception("Pandora returned an unreadable response (" + status + "). Please try again."); }
            }
            if (status < 200 || status >= 300 || response.optInt("errorCode") != 0 || "fail".equals(response.optString("stat")) || PandoraProtocol.conflict(response)) throw new ApiException(status, response, url);
            return response;
        } finally { connection.disconnect(); }
    }
    @Override public void login(String email, String password) throws Exception {
        authToken = null;
        JSONObject result = send("/v1/auth/login", PandoraProtocol.loginBody(email, password));
        if (!PandoraProtocol.paid(result)) throw new Exception("Panedora requires Pandora Plus or Premium. Free accounts are not supported.");
        String token = result.optString("authToken"); if (token.isEmpty()) throw new Exception("Pandora did not return a sign-in token.");
        authToken = token; cookies.flush();
    }
    @Override public List<PandoraProtocol.Station> stations() throws Exception { return PandoraProtocol.stations(request("/v1/station/getStations", PandoraProtocol.body("pageSize", 250, "startIndex", 0))); }
    @Override public PandoraProtocol.Station shuffleStation() throws Exception {
        PandoraProtocol.Station station = PandoraProtocol.station(request("/v1/station/shuffle",new JSONObject()),true);
        if (station == null) throw new Exception("Pandora did not return your shuffle station. Please try again.");
        return station;
    }
    @Override public List<PandoraProtocol.Track> playlist(String station, boolean first) throws Exception { return PandoraProtocol.tracks(request("/v1/playlist/getFragment", PandoraProtocol.playlistBody(station, first))); }
    @Override public void resume(boolean takeOver) throws Exception { request("/v1/station/playbackResumed", PandoraProtocol.body("forceActive", takeOver)); }
    @Override public String feedback(String token, boolean positive) throws Exception {
        JSONObject result = request("/v1/station/addFeedback", PandoraProtocol.body("trackToken", token, "isPositive", positive));
        return result.isNull("feedbackId") ? "" : result.optString("feedbackId");
    }
    @Override public void deleteFeedback(String id) throws Exception { request("/v1/station/deleteFeedback", PandoraProtocol.body("feedbackId", id)); }
    @Override public String findFeedback(PandoraProtocol.Track track) throws Exception {
        if (!track.feedbackId.isEmpty()) return track.feedbackId;
        if (track.stationId.isEmpty() || (track.musicId.isEmpty() && track.pandoraId.isEmpty())) return "";
        long deadline = System.currentTimeMillis() + 15000;
        for (int start = 0; start < 5000 && System.currentTimeMillis() < deadline; start += 100) {
            JSONObject result = request("/v1/station/getStationFeedback", PandoraProtocol.body("stationId",track.stationId,"positive",track.rating == 1,"pageSize",100,"startIndex",start));
            JSONArray entries = result.optJSONArray("feedback");
            String id = PandoraProtocol.matchingFeedback(entries,track); if (!id.isEmpty()) return id;
            if (entries == null || entries.length() == 0 || start + entries.length() >= result.optInt("total",start + entries.length())) break;
        }
        return "";
    }
    @Override public void started(String station, String token) throws Exception { request("/v1/station/trackStarted", PandoraProtocol.body("stationId", station, "trackToken", token)); }
    @Override public void paused(String station, String token) throws Exception { request("/v1/station/playbackPaused", PandoraProtocol.body("stationId", station, "trackToken", token)); }
    @Override public void clear() { authToken = null; cookies.removeAllCookies(null); cookies.flush(); }
}
