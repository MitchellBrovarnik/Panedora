package app.panedora.mobile;

import java.util.List;

interface PandoraGateway {
    void login(String email, String password) throws Exception;
    List<PandoraProtocol.Station> stations() throws Exception;
    List<PandoraProtocol.Track> playlist(String station, boolean first) throws Exception;
    void resume(boolean takeOver) throws Exception;
    void feedback(String token, boolean positive) throws Exception;
    void started(String station, String token) throws Exception;
    void paused(String station, String token) throws Exception;
    void clear();
}
