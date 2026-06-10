import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId:   'com.ridemesh.app',
  appName: 'CALO',
  webDir:  'dist/calo/browser',

  server: {
    // Allow navigation to tile servers and Nominatim for geocoding
    allowNavigation: [
      'tile.openstreetmap.org',
      'tiles.stadiamaps.com',
      'nominatim.openstreetmap.org',
    ],
    // Deep-dark background so the WebView doesn't flash white on load
    backgroundColor: '#070710',
  },

  android: {
    allowMixedContent:    true,   // some OSM tile mirrors still serve HTTP
    captureInput:         true,   // better input handling for text fields
    webContentsDebuggingEnabled: false,
    backgroundColor: '#070710',
  },

  plugins: {
    SplashScreen: {
      launchShowDuration:   1200,
      launchAutoHide:       true,
      backgroundColor:      '#070710',
      androidSplashResourceName: 'splash',
      showSpinner:          false,
      splashFullScreen:     true,
      splashImmersive:      true,
    },
  },
};

export default config;
