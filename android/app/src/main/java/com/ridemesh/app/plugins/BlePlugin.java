package com.ridemesh.app.plugins;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
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
import android.os.Build;
import android.os.ParcelUuid;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@CapacitorPlugin(
    name = "BlePlugin",
    permissions = {
        @Permission(strings = { Manifest.permission.BLUETOOTH_SCAN },      alias = "bluetoothScan"),
        @Permission(strings = { Manifest.permission.BLUETOOTH_ADVERTISE }, alias = "bluetoothAdvertise"),
        @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT },   alias = "bluetoothConnect"),
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION }, alias = "location"),
    }
)
public class BlePlugin extends Plugin {

    private static final String TAG         = "BlePlugin";
    // Service UUID that all RideMesh devices advertise
    private static final String SERVICE_UUID = "0000FEED-0000-1000-8000-00805F9B34FB";
    // Characteristic for rider beacon payload (name + callsign + status)
    private static final String BEACON_CHAR  = "0000BEA0-0000-1000-8000-00805F9B34FB";

    private BluetoothAdapter    btAdapter;
    private BluetoothLeScanner  leScanner;
    private BluetoothLeAdvertiser leAdvertiser;
    private ScanCallback        scanCallback;
    private AdvertiseCallback   advertiseCallback;
    private boolean             isScanning    = false;
    private boolean             isAdvertising = false;

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    @Override
    public void load() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        if (manager != null) {
            btAdapter = manager.getAdapter();
        }
    }

    // ─── Plugin Methods ───────────────────────────────────────────────────────

    @PluginMethod
    public void startScan(PluginCall call) {
        if (!checkBt(call)) return;
        if (isScanning) { call.resolve(); return; }

        leScanner = btAdapter.getBluetoothLeScanner();
        if (leScanner == null) { call.reject("BLE scanner unavailable"); return; }

        ScanSettings settings = new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build();

        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder()
            .setServiceUuid(ParcelUuid.fromString(SERVICE_UUID))
            .build());

        scanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
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

    @PluginMethod
    public void stopScan(PluginCall call) {
        if (leScanner != null && scanCallback != null && isScanning) {
            leScanner.stopScan(scanCallback);
            isScanning = false;
        }
        call.resolve();
    }

    @PluginMethod
    public void startAdvertise(PluginCall call) {
        if (!checkBt(call)) return;
        if (isAdvertising) { call.resolve(); return; }

        String payload = call.getString("payload", "");

        leAdvertiser = btAdapter.getBluetoothLeAdvertiser();
        if (leAdvertiser == null) { call.reject("BLE advertising not supported"); return; }

        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(false)
            .setTimeout(0)
            .build();

        byte[] data = payload != null ? payload.getBytes(StandardCharsets.UTF_8) : new byte[0];
        // Truncate to 20 bytes (BLE advertisement payload limit)
        if (data.length > 20) {
            byte[] trimmed = new byte[20];
            System.arraycopy(data, 0, trimmed, 0, 20);
            data = trimmed;
        }

        AdvertiseData advData = new AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid.fromString(SERVICE_UUID))
            .addServiceData(ParcelUuid.fromString(SERVICE_UUID), data)
            .setIncludeDeviceName(false)
            .build();

        advertiseCallback = new AdvertiseCallback() {
            @Override public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                isAdvertising = true;
                JSObject ev = new JSObject();
                ev.put("advertising", true);
                notifyListeners("advertiseStarted", ev);
            }
            @Override public void onStartFailure(int errorCode) {
                call.reject("Advertise failed: " + errorCode);
            }
        };

        leAdvertiser.startAdvertising(settings, advData, advertiseCallback);
        call.resolve();
    }

    @PluginMethod
    public void stopAdvertise(PluginCall call) {
        if (leAdvertiser != null && advertiseCallback != null && isAdvertising) {
            leAdvertiser.stopAdvertising(advertiseCallback);
            isAdvertising = false;
        }
        call.resolve();
    }

    @PluginMethod
    public void isBluetoothEnabled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", btAdapter != null && btAdapter.isEnabled());
        call.resolve(result);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private void emitScanResult(ScanResult result) {
        BluetoothDevice device = result.getDevice();
        ScanRecord record = result.getScanRecord();

        String payload = "";
        if (record != null) {
            byte[] serviceData = record.getServiceData(ParcelUuid.fromString(SERVICE_UUID));
            if (serviceData != null) {
                payload = new String(serviceData, StandardCharsets.UTF_8);
            }
        }

        JSObject ev = new JSObject();
        ev.put("deviceAddress", device.getAddress());
        ev.put("deviceName",    device.getName() != null ? device.getName() : "Unknown");
        ev.put("rssi",          result.getRssi());
        ev.put("payload",       payload);
        notifyListeners("deviceFound", ev);
    }

    private boolean checkBt(PluginCall call) {
        if (btAdapter == null || !btAdapter.isEnabled()) {
            call.reject("Bluetooth not available or disabled");
            return false;
        }
        return true;
    }
}
