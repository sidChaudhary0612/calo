package com.ridemesh.app.plugins;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pDevice;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.Collection;

@CapacitorPlugin(
    name = "WifiDirect",
    permissions = {
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION },  alias = "location"),
        @Permission(strings = { Manifest.permission.NEARBY_WIFI_DEVICES },   alias = "nearbyWifi"),
        @Permission(strings = { Manifest.permission.ACCESS_WIFI_STATE },     alias = "wifiState"),
        @Permission(strings = { Manifest.permission.CHANGE_WIFI_STATE },     alias = "changeWifi"),
        @Permission(strings = { Manifest.permission.CHANGE_NETWORK_STATE },  alias = "networkState"),
        @Permission(strings = { Manifest.permission.INTERNET },              alias = "internet"),
    }
)
public class WifiDirectPlugin extends Plugin {

    private static final String TAG = "WifiDirectPlugin";

    private WifiP2pManager            p2pManager;
    private WifiP2pManager.Channel    p2pChannel;
    private BroadcastReceiver         receiver;
    private boolean                   isDiscovering = false;

    private PluginCall savedDiscoveryCall;

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    @Override
    public void load() {
        p2pManager = (WifiP2pManager) getContext().getSystemService(Context.WIFI_P2P_SERVICE);
        if (p2pManager != null) {
            p2pChannel = p2pManager.initialize(getContext(), getActivity().getMainLooper(), null);
        }
        registerReceiver();
    }

    @Override
    protected void handleOnDestroy() {
        unregisterReceiver();
    }

    @Override
    protected void handleOnResume() {
        if (receiver == null) registerReceiver();
    }

    @Override
    protected void handleOnPause() {
        unregisterReceiver();
    }

    // ─── Plugin Methods ───────────────────────────────────────────────────────

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (p2pManager == null) { call.reject("Wi-Fi Direct not available on this device"); return; }

        // Android 13+: NEARBY_WIFI_DEVICES; Android <13: ACCESS_FINE_LOCATION
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (getContext().checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED) {
                savedDiscoveryCall = call;
                requestPermissionForAlias("nearbyWifi", call, "discoveryPermissionCallback");
                return;
            }
        } else {
            if (getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                savedDiscoveryCall = call;
                requestPermissionForAlias("location", call, "discoveryPermissionCallback");
                return;
            }
        }
        doStartDiscovery(call);
    }

    @PermissionCallback
    private void discoveryPermissionCallback(PluginCall call) {
        PluginCall target = savedDiscoveryCall != null ? savedDiscoveryCall : call;
        savedDiscoveryCall = null;

        boolean granted;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            granted = getContext().checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED;
        } else {
            granted = getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        }

        if (!granted) { target.reject("Wi-Fi Direct permission denied"); return; }
        doStartDiscovery(target);
    }

    private void doStartDiscovery(PluginCall call) {
        p2pManager.discoverPeers(p2pChannel, new WifiP2pManager.ActionListener() {
            @Override public void onSuccess() {
                isDiscovering = true;
                call.resolve();
            }
            @Override public void onFailure(int reason) {
                call.reject("Discovery failed: " + reasonString(reason));
            }
        });
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        if (p2pManager == null) { call.resolve(); return; }
        p2pManager.stopPeerDiscovery(p2pChannel, new WifiP2pManager.ActionListener() {
            @Override public void onSuccess() { isDiscovering = false; call.resolve(); }
            @Override public void onFailure(int r) { call.resolve(); }
        });
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String deviceAddress = call.getString("deviceAddress");
        if (deviceAddress == null) { call.reject("deviceAddress required"); return; }
        if (p2pManager == null) { call.reject("Wi-Fi Direct not available"); return; }

        // Android 13+: NEARBY_WIFI_DEVICES is required to call p2pManager.connect()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (getContext().checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED) {
                savedDiscoveryCall = call;
                requestPermissionForAlias("nearbyWifi", call, "discoveryPermissionCallback");
                return;
            }
        }

        WifiP2pConfig config = new WifiP2pConfig();
        config.deviceAddress = deviceAddress;

        p2pManager.connect(p2pChannel, config, new WifiP2pManager.ActionListener() {
            @Override public void onSuccess() { call.resolve(); }
            @Override public void onFailure(int r) { call.reject("Connect failed: " + reasonString(r)); }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        if (p2pManager == null) { call.resolve(); return; }
        p2pManager.removeGroup(p2pChannel, new WifiP2pManager.ActionListener() {
            @Override public void onSuccess() { call.resolve(); }
            @Override public void onFailure(int r) { call.reject("Disconnect failed: " + reasonString(r)); }
        });
    }

    @PluginMethod
    public void requestConnectionInfo(PluginCall call) {
        if (p2pManager == null) { call.reject("Wi-Fi Direct not available"); return; }
        p2pManager.requestConnectionInfo(p2pChannel, info -> {
            JSObject result = new JSObject();
            result.put("groupFormed",       info.groupFormed);
            result.put("isGroupOwner",      info.isGroupOwner);
            result.put("groupOwnerAddress", info.groupFormed ? info.groupOwnerAddress.getHostAddress() : null);
            call.resolve(result);
        });
    }

    // ─── Broadcast Receiver ───────────────────────────────────────────────────

    private void registerReceiver() {
        if (p2pManager == null) return;

        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION);

        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (action == null) return;
                switch (action) {
                    case WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION:
                        onPeersChanged();
                        break;
                    case WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION:
                        onConnectionChanged(intent);
                        break;
                    case WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION:
                        int state = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1);
                        JSObject ev = new JSObject();
                        ev.put("enabled", state == WifiP2pManager.WIFI_P2P_STATE_ENABLED);
                        notifyListeners("wifiDirectStateChanged", ev);
                        break;
                }
            }
        };

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }

    private void unregisterReceiver() {
        if (receiver != null) {
            try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) {}
            receiver = null;
        }
    }

    private void onPeersChanged() {
        if (p2pManager == null || p2pChannel == null) return;
        p2pManager.requestPeers(p2pChannel, peers -> {
            Collection<WifiP2pDevice> deviceList = peers.getDeviceList();
            JSArray arr = new JSArray();
            for (WifiP2pDevice d : deviceList) {
                JSObject peer = new JSObject();
                peer.put("deviceName",    d.deviceName);
                peer.put("deviceAddress", d.deviceAddress);
                peer.put("status",        d.status);
                arr.put(peer);
            }
            JSObject ev = new JSObject();
            ev.put("peers", arr);
            notifyListeners("peersChanged", ev);
        });
    }

    private void onConnectionChanged(Intent intent) {
        WifiP2pInfo info;
        // getParcelableExtra(String) is deprecated in API 33 — use typed version when available
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            info = intent.getParcelableExtra(WifiP2pManager.EXTRA_WIFI_P2P_INFO, WifiP2pInfo.class);
        } else {
            //noinspection deprecation
            info = intent.getParcelableExtra(WifiP2pManager.EXTRA_WIFI_P2P_INFO);
        }
        if (info == null) return;

        JSObject ev = new JSObject();
        ev.put("groupFormed",       info.groupFormed);
        ev.put("isGroupOwner",      info.isGroupOwner);
        ev.put("groupOwnerAddress", info.groupFormed ? info.groupOwnerAddress.getHostAddress() : null);
        notifyListeners("connectionChanged", ev);
    }

    private String reasonString(int r) {
        switch (r) {
            case WifiP2pManager.ERROR:            return "Internal error";
            case WifiP2pManager.P2P_UNSUPPORTED:  return "P2P unsupported on this device";
            case WifiP2pManager.BUSY:             return "Framework busy — try again";
            default:                              return "Unknown (" + r + ")";
        }
    }
}
