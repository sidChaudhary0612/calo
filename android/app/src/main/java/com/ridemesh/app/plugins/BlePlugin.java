package com.ridemesh.app.plugins;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.ParcelUuid;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@CapacitorPlugin(
    name = "BlePlugin",
    permissions = {
        @Permission(strings = { Manifest.permission.BLUETOOTH_SCAN },       alias = "bluetoothScan"),
        @Permission(strings = { Manifest.permission.BLUETOOTH_ADVERTISE },  alias = "bluetoothAdvertise"),
        @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT },    alias = "bluetoothConnect"),
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION }, alias = "location"),
    }
)
public class BlePlugin extends Plugin {

    private static final String TAG          = "BlePlugin";
    private static final UUID   SERVICE_UUID = UUID.fromString("0000FEED-0000-1000-8000-00805F9B34FB");
    // GATT characteristic that holds the full beacon JSON (no size limit)
    private static final UUID   BEACON_CHAR  = UUID.fromString("0000BEA0-0000-1000-8000-00805F9B34FB");
    // GATT characteristic scanners WRITE to, to push a group invite / response
    private static final UUID   INVITE_CHAR  = UUID.fromString("0000BEA1-0000-1000-8000-00805F9B34FB");

    // Manufacturer-specific advertisement data. Company id 0xFFFF is the reserved
    // "for testing" id; the leading magic byte lets us reject foreign 0xFFFF ads.
    private static final int    MANUFACTURER_ID = 0xFFFF;
    private static final byte   BEACON_MAGIC    = (byte) 0x52; // 'R'

    private BluetoothManager      btManager;
    private BluetoothAdapter      btAdapter;
    private BluetoothLeScanner    leScanner;
    private BluetoothLeAdvertiser leAdvertiser;
    private BluetoothGattServer   gattServer;
    private ScanCallback          scanCallback;
    private AdvertiseCallback     advertiseCallback;
    private boolean               isScanning    = false;
    private boolean               isAdvertising = false;
    private byte[]                cachedBeaconPayload = new byte[0];
    // Track addresses with an in-flight GATT op (read or invite write) to avoid
    // concurrent connection storms to the same device.
    private final java.util.Set<String> pendingGattReads = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    private final android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    private PluginCall savedScanCall;
    private PluginCall savedAdvertiseCall;

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    @Override
    public void load() {
        btManager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        if (btManager != null) btAdapter = btManager.getAdapter();
    }

    // ─── startScan ────────────────────────────────────────────────────────────

    @PluginMethod
    public void startScan(PluginCall call) {
        if (!checkBt(call)) return;
        if (isScanning) { call.resolve(); return; }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            boolean scanGranted    = getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)    == PackageManager.PERMISSION_GRANTED;
            boolean connectGranted = getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
            // BLUETOOTH_CONNECT is needed to run the GATT server (advertiser) and read
            // peer names / beacon payloads (scanner), so request it alongside SCAN.
            if (!scanGranted || !connectGranted) {
                savedScanCall = call;
                requestPermissionForAliases(new String[]{ "bluetoothScan", "bluetoothConnect" }, call, "scanPermissionCallback");
                return;
            }
        } else {
            if (getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                savedScanCall = call;
                requestPermissionForAlias("location", call, "scanPermissionCallback");
                return;
            }
        }
        doStartScan(call);
    }

    @PermissionCallback
    private void scanPermissionCallback(PluginCall call) {
        PluginCall target = savedScanCall != null ? savedScanCall : call;
        savedScanCall = null;
        boolean granted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ? getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
            : getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (!granted) { target.reject("Bluetooth scan permission denied"); return; }
        doStartScan(target);
    }

    private void doStartScan(PluginCall call) {
        leScanner = btAdapter.getBluetoothLeScanner();
        if (leScanner == null) { call.reject("BLE scanner unavailable"); return; }

        ScanSettings settings = new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build();

        // No service-UUID filter — some Android chipsets drop the filter silently when
        // the advertiser sets neverForLocation. We check SERVICE_UUID in emitScanResult.
        List<ScanFilter> filters = new ArrayList<>();

        scanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                ScanRecord rec = result.getScanRecord();
                // Only surface devices that carry our service UUID
                if (rec == null) return;
                List<ParcelUuid> uuids = rec.getServiceUuids();
                if (uuids == null || !uuids.contains(new ParcelUuid(SERVICE_UUID))) return;
                emitScanResult(result);
            }
            @Override
            public void onScanFailed(int errorCode) {
                JSObject ev = new JSObject();
                ev.put("error", "Scan failed: " + errorCode);
                notifyListeners("scanFailed", ev);
            }
        };

        leScanner.startScan(filters, settings, scanCallback);
        isScanning = true;
        call.resolve();
    }

    // ─── stopScan ─────────────────────────────────────────────────────────────

    @PluginMethod
    public void stopScan(PluginCall call) {
        if (leScanner != null && scanCallback != null && isScanning) {
            try { leScanner.stopScan(scanCallback); } catch (Exception ignored) {}
            isScanning = false;
        }
        call.resolve();
    }

    // ─── startAdvertise ───────────────────────────────────────────────────────
    //
    // Strategy: the BLE advertisement packet only carries the SERVICE_UUID (presence
    // marker).  The full JSON beacon is stored in a GATT characteristic so there is
    // no 20-byte size limit.  Scanners that receive the advertisement read the
    // characteristic via the service-data bytes we embed (first 20 bytes of JSON as
    // a fast-path), then fall back to a GATT read if they need the full payload.
    //
    // To keep things simple for the current peer-discovery use-case we embed as many
    // bytes of the JSON as fit (up to 20) in the service-data field AND host a GATT
    // server with the full payload for any scanner that wants to do a proper read.

    @PluginMethod
    public void startAdvertise(PluginCall call) {
        if (!checkBt(call)) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED) {
                savedAdvertiseCall = call;
                requestPermissionForAlias("bluetoothAdvertise", call, "advertisePermissionCallback");
                return;
            }
        }
        doStartAdvertise(call);
    }

    @PermissionCallback
    private void advertisePermissionCallback(PluginCall call) {
        PluginCall target = savedAdvertiseCall != null ? savedAdvertiseCall : call;
        savedAdvertiseCall = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED) {
            target.reject("Bluetooth advertise permission denied");
            return;
        }
        doStartAdvertise(target);
    }

    private void doStartAdvertise(PluginCall call) {
        String payload = call.getString("payload", "");
        byte[] fullData = (payload != null ? payload : "").getBytes(StandardCharsets.UTF_8);

        // Cache for GATT reads
        cachedBeaconPayload = fullData;

        // Update GATT characteristic value if server is already running
        updateGattCharacteristic(fullData);

        // If already advertising, just update the cached payload and restart
        // so the new group passcode gets broadcast.
        if (isAdvertising && leAdvertiser != null && advertiseCallback != null) {
            try { leAdvertiser.stopAdvertising(advertiseCallback); } catch (Exception ignored) {}
            isAdvertising = false;
        }

        leAdvertiser = btAdapter.getBluetoothLeAdvertiser();
        if (leAdvertiser == null) {
            // Device doesn't support peripheral mode — still start GATT server for reads
            startGattServer(fullData);
            call.resolve();
            return;
        }

        // Start GATT server to serve the full payload on BLUETOOTH_CONNECT reads
        startGattServer(fullData);

        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)   // connectable so scanners can do a GATT read
            .setTimeout(0)
            .build();

        // Advertise the service UUID as a presence marker AND a compact beacon in
        // manufacturer-specific data (a separate AD structure — it does NOT collide
        // with the service UUID the way addServiceData did). This carries status,
        // battery and the group passcode without needing a GATT read, so group
        // discovery/join works even when phone-to-phone GATT connections fail.
        // The full name is still served via the GATT characteristic as a fallback.
        AdvertiseData.Builder advBuilder = new AdvertiseData.Builder()
            .addServiceUuid(new ParcelUuid(SERVICE_UUID))
            .setIncludeDeviceName(false);

        byte[] mfg = encodeBeacon(payload);
        if (mfg != null) {
            advBuilder.addManufacturerData(MANUFACTURER_ID, mfg);
        }
        AdvertiseData advData = advBuilder.build();

        advertiseCallback = new AdvertiseCallback() {
            @Override public void onStartSuccess(AdvertiseSettings s) {
                isAdvertising = true;
                JSObject ev = new JSObject();
                ev.put("advertising", true);
                notifyListeners("advertiseStarted", ev);
            }
            @Override public void onStartFailure(int errorCode) {
                Log.e(TAG, "Advertise failed: " + errorCode);
                JSObject ev = new JSObject();
                ev.put("error", "Advertise failed: " + errorCode);
                notifyListeners("advertiseFailed", ev);
            }
        };

        leAdvertiser.startAdvertising(settings, advData, advertiseCallback);
        call.resolve();
    }

    // Build the compact manufacturer-data beacon from the JSON payload the JS layer
    // sends. Layout (after the 2-byte company id Android prepends):
    //   [0] magic 0x52  [1] status(0/1/2)  [2] battery(0-100, 0xFF=unknown)
    //   [3..6] passcode 4 ASCII digits or 0x00 x4  [7..] name UTF-8 (<=11 bytes)
    // Returns null if the payload can't be parsed.
    private byte[] encodeBeacon(String jsonPayload) {
        if (jsonPayload == null || jsonPayload.isEmpty()) return null;
        try {
            JSONObject o = new JSONObject(jsonPayload);
            String name = o.optString("n", "");
            String s    = o.optString("s", "offline");
            int battery = o.optInt("b", -1);
            String g    = o.optString("g", "");

            byte status = (byte) ("online".equals(s) ? 1 : "away".equals(s) ? 2 : 0);
            byte batt   = (byte) (battery >= 0 && battery <= 100 ? battery : 0xFF);

            byte[] nameBytes = name.getBytes(StandardCharsets.UTF_8);
            int nameLen = Math.min(nameBytes.length, 11);

            byte[] out = new byte[7 + nameLen];
            out[0] = BEACON_MAGIC;
            out[1] = status;
            out[2] = batt;
            // passcode: exactly 4 ASCII digits, else zero-filled
            if (g.length() == 4) {
                byte[] gb = g.getBytes(StandardCharsets.US_ASCII);
                out[3] = gb[0]; out[4] = gb[1]; out[5] = gb[2]; out[6] = gb[3];
            }
            System.arraycopy(nameBytes, 0, out, 7, nameLen);
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    // Decode a manufacturer-data beacon back into the same compact JSON keys the JS
    // layer already parses (n/s/b/g). Returns null if it isn't one of our beacons.
    private String decodeBeacon(byte[] mfg) {
        if (mfg == null || mfg.length < 7 || mfg[0] != BEACON_MAGIC) return null;
        try {
            String status = mfg[1] == 1 ? "online" : mfg[1] == 2 ? "away" : "offline";
            int batt = mfg[2] & 0xFF;
            String g = "";
            if (mfg[3] != 0) {
                g = new String(mfg, 3, 4, StandardCharsets.US_ASCII);
            }
            String name = mfg.length > 7
                ? new String(mfg, 7, mfg.length - 7, StandardCharsets.UTF_8)
                : "";

            JSONObject o = new JSONObject();
            o.put("n", name);
            o.put("s", status);
            if (batt != 0xFF) o.put("b", batt);
            if (!g.isEmpty())  o.put("g", g);
            return o.toString();
        } catch (Exception e) {
            return null;
        }
    }

    // ─── stopAdvertise ────────────────────────────────────────────────────────

    @PluginMethod
    public void stopAdvertise(PluginCall call) {
        if (leAdvertiser != null && advertiseCallback != null && isAdvertising) {
            try { leAdvertiser.stopAdvertising(advertiseCallback); } catch (Exception ignored) {}
            isAdvertising = false;
        }
        stopGattServer();
        call.resolve();
    }

    @PluginMethod
    public void isBluetoothEnabled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", btAdapter != null && btAdapter.isEnabled());
        call.resolve(result);
    }

    // ─── sendInvite (GATT write to a peer's INVITE_CHAR) ──────────────────────
    //
    // Pushes a small (<=20 byte) invite/response payload to another rider without
    // needing a prior Wi-Fi Direct / TCP link. The receiver's GATT server surfaces
    // it via the "inviteReceived" event.

    @PluginMethod
    public void sendInvite(PluginCall call) {
        String deviceAddress = call.getString("deviceAddress");
        String payload       = call.getString("payload", "");
        if (deviceAddress == null || deviceAddress.isEmpty()) { call.reject("deviceAddress required"); return; }
        if (btAdapter == null) { call.reject("Bluetooth unavailable"); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            call.reject("BLUETOOTH_CONNECT permission required");
            return;
        }
        byte[] data = (payload != null ? payload : "").getBytes(StandardCharsets.UTF_8);
        attemptInviteWrite(deviceAddress, data, call, 1); // one retry
    }

    private void attemptInviteWrite(String deviceAddress, byte[] data, PluginCall call, int retriesLeft) {
        final BluetoothDevice device;
        try { device = btAdapter.getRemoteDevice(deviceAddress); }
        catch (Exception e) { call.reject("Invalid device address"); return; }

        // Serialize against scanner reads / other writes to the same device.
        if (!pendingGattReads.add(deviceAddress)) {
            mainHandler.postDelayed(() -> attemptInviteWrite(deviceAddress, data, call, retriesLeft), 400);
            return;
        }

        final java.util.concurrent.atomic.AtomicBoolean settled = new java.util.concurrent.atomic.AtomicBoolean(false);

        device.connectGatt(getContext(), false, new android.bluetooth.BluetoothGattCallback() {
            private void retryOrFail(BluetoothGatt gatt) {
                pendingGattReads.remove(deviceAddress);
                try { if (gatt != null) gatt.close(); } catch (Exception ignored) {}
                if (settled.getAndSet(true)) return;
                if (retriesLeft > 0) {
                    mainHandler.postDelayed(() -> attemptInviteWrite(deviceAddress, data, call, retriesLeft - 1), 400);
                } else {
                    call.reject("Invite write failed");
                }
            }
            @Override
            public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                if (newState == BluetoothGatt.STATE_CONNECTED) {
                    gatt.discoverServices();
                } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                    retryOrFail(gatt);
                }
            }
            @Override
            public void onServicesDiscovered(BluetoothGatt gatt, int status) {
                BluetoothGattService svc = gatt.getService(SERVICE_UUID);
                BluetoothGattCharacteristic ch = svc != null ? svc.getCharacteristic(INVITE_CHAR) : null;
                if (ch == null) { gatt.disconnect(); return; }
                ch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                ch.setValue(data);
                if (!gatt.writeCharacteristic(ch)) { gatt.disconnect(); }
            }
            @Override
            public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic ch, int status) {
                pendingGattReads.remove(deviceAddress);
                boolean ok = status == BluetoothGatt.GATT_SUCCESS;
                try { gatt.disconnect(); gatt.close(); } catch (Exception ignored) {}
                if (settled.getAndSet(true)) return;
                if (ok) {
                    call.resolve();
                } else if (retriesLeft > 0) {
                    mainHandler.postDelayed(() -> attemptInviteWrite(deviceAddress, data, call, retriesLeft - 1), 400);
                } else {
                    call.reject("Invite write failed");
                }
            }
        });
    }

    // ─── GATT server (serves full beacon payload to connecting scanners) ──────

    private void startGattServer(byte[] payload) {
        if (btManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            return; // Can't open GATT server without BLUETOOTH_CONNECT
        }

        stopGattServer();

        BluetoothGattService service = new BluetoothGattService(SERVICE_UUID,
            BluetoothGattService.SERVICE_TYPE_PRIMARY);

        BluetoothGattCharacteristic characteristic = new BluetoothGattCharacteristic(
            BEACON_CHAR,
            BluetoothGattCharacteristic.PROPERTY_READ,
            BluetoothGattCharacteristic.PERMISSION_READ);
        characteristic.setValue(payload);
        service.addCharacteristic(characteristic);

        // Writable characteristic that peers push group invites / responses to.
        BluetoothGattCharacteristic inviteChar = new BluetoothGattCharacteristic(
            INVITE_CHAR,
            BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE);
        service.addCharacteristic(inviteChar);

        gattServer = btManager.openGattServer(getContext(), new BluetoothGattServerCallback() {
            @Override
            public void onCharacteristicReadRequest(BluetoothDevice device, int requestId,
                    int offset, BluetoothGattCharacteristic characteristic) {
                if (gattServer == null) return;
                byte[] value = cachedBeaconPayload;
                byte[] response = offset < value.length
                    ? java.util.Arrays.copyOfRange(value, offset, value.length)
                    : new byte[0];
                gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, response);
            }
            @Override
            public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                    BluetoothGattCharacteristic characteristic, boolean preparedWrite,
                    boolean responseNeeded, int offset, byte[] value) {
                if (INVITE_CHAR.equals(characteristic.getUuid())) {
                    if (responseNeeded && gattServer != null) {
                        gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value);
                    }
                    String payloadStr = value != null ? new String(value, StandardCharsets.UTF_8) : "";
                    JSObject ev = new JSObject();
                    ev.put("payload",     payloadStr);
                    ev.put("fromAddress", device.getAddress());
                    notifyListeners("inviteReceived", ev);
                } else if (responseNeeded && gattServer != null) {
                    gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null);
                }
            }
            @Override
            public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
                // No-op — we only serve reads/writes, no persistent connection needed
            }
        });

        if (gattServer != null) {
            gattServer.addService(service);
        }
    }

    private void updateGattCharacteristic(byte[] payload) {
        if (gattServer == null) return;
        BluetoothGattService svc = gattServer.getService(SERVICE_UUID);
        if (svc == null) return;
        BluetoothGattCharacteristic ch = svc.getCharacteristic(BEACON_CHAR);
        if (ch != null) ch.setValue(payload);
    }

    private void stopGattServer() {
        if (gattServer != null) {
            try { gattServer.close(); } catch (Exception ignored) {}
            gattServer = null;
        }
    }

    // ─── Scan result emission ─────────────────────────────────────────────────

    private void emitScanResult(ScanResult result) {
        BluetoothDevice device = result.getDevice();
        ScanRecord record = result.getScanRecord();

        String deviceName = "Unknown";
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
                getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) {
                String n = device.getName();
                if (n != null) deviceName = n;
            }
        } catch (Exception ignored) {}

        // Fast path: decode the compact beacon carried in manufacturer-specific data.
        // This gives us status/battery/passcode without any GATT connection.
        String fastPayload = "";
        if (record != null) {
            byte[] mfg = record.getManufacturerSpecificData(MANUFACTURER_ID);
            String decoded = decodeBeacon(mfg);
            if (decoded != null) fastPayload = decoded;
        }

        final String finalDeviceName = deviceName;
        final int rssi = result.getRssi();

        // ALWAYS surface the rider the instant we detect its beacon. Presence alone
        // is enough to show a blip; the name/battery/status are enriched below via a
        // GATT read once (and if) it succeeds. Emitting here guarantees the rider
        // never disappears just because the phone-to-phone GATT connection fails —
        // which is common when both devices advertise + scan + serve GATT at once.
        emitDevice(device.getAddress(), finalDeviceName, rssi, fastPayload);

        // If we already got a full JSON object from service data, nothing to enrich.
        if (fastPayload.startsWith("{") && fastPayload.endsWith("}")) {
            return;
        }

        // Payload is missing or truncated — do a GATT read to get the full beacon.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            // No CONNECT permission — presence emit above is all we can do.
            return;
        }

        // Avoid concurrent GATT connections to the same device — Android limits these
        // and simultaneous attempts cause both to fail silently on many chipsets.
        final String deviceAddr = device.getAddress();
        if (!pendingGattReads.add(deviceAddr)) {
            return; // already reading this device
        }

        final String partialPayload = fastPayload;
        device.connectGatt(getContext(), false, new android.bluetooth.BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                if (newState == BluetoothGatt.STATE_CONNECTED) {
                    gatt.discoverServices();
                } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                    pendingGattReads.remove(deviceAddr);
                    gatt.close();
                }
            }
            @Override
            public void onServicesDiscovered(BluetoothGatt gatt, int status) {
                BluetoothGattService svc = gatt.getService(SERVICE_UUID);
                if (svc == null) {
                    gatt.disconnect();
                    emitDevice(deviceAddr, finalDeviceName, rssi, partialPayload);
                    return;
                }
                BluetoothGattCharacteristic ch = svc.getCharacteristic(BEACON_CHAR);
                if (ch == null) {
                    gatt.disconnect();
                    emitDevice(deviceAddr, finalDeviceName, rssi, partialPayload);
                    return;
                }
                gatt.readCharacteristic(ch);
            }
            @Override
            public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
                String fullPayload = partialPayload;
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    byte[] val = characteristic.getValue();
                    if (val != null) fullPayload = new String(val, StandardCharsets.UTF_8);
                }
                gatt.disconnect();
                emitDevice(deviceAddr, finalDeviceName, rssi, fullPayload);
            }
        });
    }

    private void emitDevice(String address, String deviceName, int rssi, String payload) {
        JSObject ev = new JSObject();
        ev.put("deviceAddress", address);
        ev.put("deviceName",    deviceName);
        ev.put("rssi",          rssi);
        ev.put("payload",       payload);
        notifyListeners("deviceFound", ev);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private boolean checkBt(PluginCall call) {
        if (btAdapter == null || !btAdapter.isEnabled()) {
            call.reject("Bluetooth not available or disabled");
            return false;
        }
        return true;
    }
}
