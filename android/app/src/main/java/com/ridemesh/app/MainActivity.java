package com.ridemesh.app;

import com.getcapacitor.BridgeActivity;
import com.ridemesh.app.plugins.WifiDirectPlugin;
import com.ridemesh.app.plugins.BlePlugin;
import com.ridemesh.app.plugins.P2pSocketPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(WifiDirectPlugin.class);
        registerPlugin(BlePlugin.class);
        registerPlugin(P2pSocketPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
