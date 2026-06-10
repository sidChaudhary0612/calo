package com.ridemesh.app;

import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
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
    }
}
