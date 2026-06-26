package com.ridemesh.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.PermissionRequest;

import androidx.core.app.ActivityCompat;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.ridemesh.app.plugins.WifiDirectPlugin;
import com.ridemesh.app.plugins.BlePlugin;
import com.ridemesh.app.plugins.P2pSocketPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Install splash screen before super.onCreate so the transition is smooth
        SplashScreen.installSplashScreen(this);

        registerPlugin(WifiDirectPlugin.class);
        registerPlugin(BlePlugin.class);
        registerPlugin(P2pSocketPlugin.class);
        super.onCreate(savedInstanceState);

        // WebRTC full-duplex voice: getUserMedia() is gated by the WebView layer
        // independently of the OS RECORD_AUDIO grant. Subclass Capacitor's own
        // WebChromeClient (to keep its file-chooser / console behaviour) and grant
        // microphone capture so the mic stream can start inside the WebView.
        this.getBridge().getWebView().setWebChromeClient(
            new BridgeWebChromeClient(this.getBridge()) {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    runOnUiThread(() -> {
                        for (String resource : request.getResources()) {
                            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                                request.grant(new String[]{ PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                                return;
                            }
                        }
                        request.deny();
                    });
                }
            }
        );

        // The WebView grant above only succeeds if the app itself holds the
        // OS-level RECORD_AUDIO permission, so request it up front.
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this, new String[]{ Manifest.permission.RECORD_AUDIO }, 9101);
        }
    }
}
