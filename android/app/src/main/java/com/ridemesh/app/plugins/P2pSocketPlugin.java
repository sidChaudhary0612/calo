package com.ridemesh.app.plugins;

import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * TCP socket layer that runs on top of the Wi-Fi Direct P2P group.
 *
 * Group owner  → runs the ServerSocket (port 9877)
 * Group member → connects to group owner's IP
 *
 * Wire protocol (binary framing):
 *   [4 bytes: channel tag length][channel tag bytes][4 bytes: payload length][payload bytes]
 *
 * Channels used by the app:
 *   ptt-audio   — raw PCM / Opus audio chunks (base64 in JS, raw bytes here)
 *   location    — JSON rider location update
 *   message     — JSON chat/coordination message
 *   sos         — JSON emergency alert
 */
@CapacitorPlugin(name = "P2pSocket")
public class P2pSocketPlugin extends Plugin {

    private static final String TAG  = "P2pSocket";
    private static final int    PORT = 9877;

    private ServerSocket                      serverSocket;
    private final Map<String, Socket>         peers      = new ConcurrentHashMap<>();
    private final Map<String, DataOutputStream> writers   = new ConcurrentHashMap<>();
    private final ExecutorService             executor   = Executors.newCachedThreadPool();

    // ─── Server (group owner) ────────────────────────────────────────────

    @PluginMethod
    public void startServer(PluginCall call) {
        executor.submit(() -> {
            try {
                serverSocket = new ServerSocket(PORT);
                call.resolve();
                Log.i(TAG, "Server listening on :" + PORT);

                while (!serverSocket.isClosed()) {
                    Socket client = serverSocket.accept();
                    String addr = client.getInetAddress().getHostAddress();
                    Log.i(TAG, "Client connected: " + addr);
                    peers.put(addr, client);
                    try { writers.put(addr, new DataOutputStream(client.getOutputStream())); } catch (IOException ignored) {}
                    executor.submit(() -> readLoop(client, addr));

                    JSObject ev = new JSObject();
                    ev.put("peerAddress", addr);
                    notifyListeners("peerConnected", ev);
                }
            } catch (IOException e) {
                if (serverSocket == null || serverSocket.isClosed()) return;
                Log.e(TAG, "Server error", e);
                call.reject("Server error: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stopServer(PluginCall call) {
        try {
            if (serverSocket != null) serverSocket.close();
            peers.values().forEach(s -> { try { s.close(); } catch (IOException ignored) {} });
            peers.clear();
            writers.clear();
        } catch (IOException e) { /* ignore */ }
        call.resolve();
    }

    // ─── Client (group member) ───────────────────────────────────────────

    @PluginMethod
    public void connect(PluginCall call) {
        String host = call.getString("host");
        if (host == null) { call.reject("host required"); return; }

        executor.submit(() -> {
            try {
                Socket s = new Socket();
                s.connect(new InetSocketAddress(host, PORT), 5000);
                peers.put(host, s);
                writers.put(host, new DataOutputStream(s.getOutputStream()));
                executor.submit(() -> readLoop(s, host));

                JSObject ev = new JSObject();
                ev.put("peerAddress", host);
                notifyListeners("peerConnected", ev);
                call.resolve();
                Log.i(TAG, "Connected to server: " + host);
            } catch (IOException e) {
                call.reject("Connect failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void disconnectPeer(PluginCall call) {
        String peer = call.getString("peerAddress");
        if (peer == null) { call.reject("peerAddress required"); return; }
        Socket s = peers.remove(peer);
        writers.remove(peer);
        if (s != null) { try { s.close(); } catch (IOException ignored) {} }
        call.resolve();
    }

    // ─── Send ────────────────────────────────────────────────────────────

    /**
     * Send a channel frame to one specific peer or broadcast to all.
     * JS passes payload as base64 string; we decode and send raw bytes.
     */
    @PluginMethod
    public void send(PluginCall call) {
        String channel    = call.getString("channel", "message");
        String payloadB64 = call.getString("payload", "");
        String target     = call.getString("target");   // null = broadcast

        byte[] channelBytes = channel.getBytes();
        byte[] payload      = Base64.decode(payloadB64, Base64.NO_WRAP);

        executor.submit(() -> {
            if (target != null) {
                writeFrame(target, channelBytes, payload);
            } else {
                for (String addr : writers.keySet()) {
                    writeFrame(addr, channelBytes, payload);
                }
            }
            call.resolve();
        });
    }

    // ─── Private read loop ───────────────────────────────────────────────

    private void readLoop(Socket socket, String peerAddr) {
        try {
            DataInputStream in = new DataInputStream(socket.getInputStream());
            while (!socket.isClosed()) {
                int chanLen    = in.readInt();
                byte[] chanBuf = new byte[chanLen];
                in.readFully(chanBuf);
                String channel = new String(chanBuf);

                int payLen    = in.readInt();
                byte[] payload = new byte[payLen];
                in.readFully(payload);

                JSObject ev = new JSObject();
                ev.put("channel",     channel);
                ev.put("payload",     Base64.encodeToString(payload, Base64.NO_WRAP));
                ev.put("peerAddress", peerAddr);
                notifyListeners("frameReceived", ev);
            }
        } catch (IOException e) {
            Log.d(TAG, "Peer disconnected: " + peerAddr);
        } finally {
            peers.remove(peerAddr);
            writers.remove(peerAddr);
            JSObject ev = new JSObject();
            ev.put("peerAddress", peerAddr);
            notifyListeners("peerDisconnected", ev);
        }
    }

    private void writeFrame(String addr, byte[] channel, byte[] payload) {
        DataOutputStream out = writers.get(addr);
        if (out == null) return;
        try {
            synchronized (out) {
                out.writeInt(channel.length);
                out.write(channel);
                out.writeInt(payload.length);
                out.write(payload);
                out.flush();
            }
        } catch (IOException e) {
            Log.w(TAG, "Write failed for " + addr + ": " + e.getMessage());
            peers.remove(addr);
            writers.remove(addr);
        }
    }
}
