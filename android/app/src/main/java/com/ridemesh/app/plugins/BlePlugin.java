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
    // Track addresses currently being GATT-read to avoid concurrent connection storms
    private final java.util.Set<String> pendingGattReads = java.util.Collections.synchronizedSet(new java.util.HashSet<>());

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
            if (getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
                savedScanCall = call;
                requestPermissionForAlias("bluetoothScan", call, "scanPermissionCallback");
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

        // Only advertise the service UUID as a presence marker — no service data.
        // Many Android chipsets silently drop or corrupt packets when addServiceData
        // and addServiceUuid use the same UUID, causing other devices to miss us.
        // Full beacon JSON is served via GATT characteristic read instead.
        AdvertiseData advData = new AdvertiseData.Builder()
            .addServiceUuid(new ParcelUuid(SERVICE_UUID))
            .setIncludeDeviceName(false)
            .build();

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
            public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
                // No-op — we only serve reads, no persistent connection needed
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

        // Try service-data fast path (first 20 bytes embedded in the advertisement)
        String fastPayload = "";
        if (record != null) {
            byte[] serviceData = record.getServiceData(new ParcelUuid(SERVICE_UUID));
            if (serviceData != null) {
                fastPayload = new String(serviceData, StandardCharsets.UTF_8);
            }
        }

        final String finalDeviceName = deviceName;
        final int rssi = result.getRssi();

        // If we got a full JSON object from service data, emit immediately
        if (fastPayload.startsWith("{") && fastPayload.endsWith("}")) {
            emitDevice(device.getAddress(), finalDeviceName, rssi, fastPayload);
            return;
        }

        // Payload is missing or truncated — do a GATT read to get the full beacon
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            // No CONNECT permission — emit with whatever we have
            emitDevice(device.getAddress(), finalDeviceName, rssi, fastPayload);
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
