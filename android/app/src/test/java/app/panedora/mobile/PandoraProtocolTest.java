package app.panedora.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class PandoraProtocolTest {
    @Test public void paidStatusRequiresPositiveEvidence() throws Exception {
        assertFalse(PandoraProtocol.paid(new JSONObject()));
        assertFalse(PandoraProtocol.paid(new JSONObject("{\"config\":{\"branding\":\"Pandora\",\"flags\":[\"adSupportedSkip\"]},\"adkv\":{\"iat\":\"1\"}}")));
        assertTrue(PandoraProtocol.paid(new JSONObject("{\"config\":{\"branding\":\"PandoraPlus\"}}")));
        assertTrue(PandoraProtocol.paid(new JSONObject("{\"config\":{\"flags\":[\"onDemand\"]}}")));
    }
    @Test public void requestsMatchTheDesktopProtocol() throws Exception {
        JSONObject login = PandoraProtocol.loginBody("test@example.invalid", "test password");
        assertTrue(login.isNull("existingAuthToken")); assertTrue(login.getBoolean("keepLoggedIn"));
        JSONObject playlist = PandoraProtocol.playlistBody("station-7", true);
        assertEquals("station-7", playlist.getString("stationId")); assertTrue(playlist.getBoolean("isStationStart"));
        assertEquals("aacplus", playlist.getString("audioFormat")); assertTrue(playlist.isNull("startingAtTrackId"));
        assertFalse(PandoraProtocol.playlistBody("station-7", false).getBoolean("isStationStart"));
    }
    @Test public void parsesRealFieldNamesAndRejectsNonMusic() throws Exception {
        JSONObject song = new JSONObject("{\"trackToken\":\"track-7\",\"songTitle\":\"After Hours\",\"artistName\":\"Northbound\",\"audioURL\":\"https://audio.example/song.aac\",\"rating\":\"1\",\"trackLength\":192}");
        JSONObject ad = new JSONObject(song.toString()).put("trackType", "AdTrack");
        JSONObject invalid = new JSONObject(song.toString()).put("audioURL", "file:///private/file");
        var tracks = PandoraProtocol.tracks(new JSONObject().put("tracks", new JSONArray().put(song).put(ad).put(invalid)));
        assertEquals(1, tracks.size()); assertEquals("After Hours", tracks.get(0).title); assertEquals(1, tracks.get(0).rating); assertEquals(192, tracks.get(0).seconds);
        assertTrue(PandoraProtocol.conflict(new JSONObject("{\"tracks\":[{\"trackType\":\"SimStreamViolationItem\"}]}")));
    }
    @Test public void artworkUsesTheLargestValidImageAndHttps() throws Exception {
        JSONArray art = new JSONArray("[{\"size\":1080},{\"size\":500,\"url\":\"http://images.example/cover.jpg\"},{\"size\":100,\"url\":\"https://images.example/small.jpg\"}]");
        assertEquals("https://images.example/cover.jpg", PandoraProtocol.artwork(art));
        assertEquals("", PandoraProtocol.https("https://secret@images.example/a"));
        assertEquals("", PandoraProtocol.https("javascript:alert(1)"));
        assertEquals("", PandoraProtocol.artwork(null));
    }
}
