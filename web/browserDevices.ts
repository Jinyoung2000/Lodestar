export const DEVICE_TYPES = ["usb", "serial", "hid", "bluetooth"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];
export type DeviceItem = { deviceId: string; label: string; detail?: string };
export type DeviceRequest = { requestId: string; origin: string; deviceType: DeviceType; devices: DeviceItem[] };

const NOUNS: Record<DeviceType, string> = { usb: "a USB device", serial: "a serial port", hid: "an HID device", bluetooth: "a Bluetooth device" };
export const DEVICE_PLACEHOLDER = "Select a device to connect to";

const host = (origin: string) => {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
};
export const devicePickerTitle = (origin: string, type: DeviceType) => `${host(origin)} wants to connect to ${NOUNS[type]}`;

const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(4, "0");
const ids = (vendorId?: number, productId?: number) => `${hex(vendorId)}:${hex(productId)}`;
const withSerial = (id: string, serial?: string) => (serial ? `${id}, ${serial}` : id);

export type UsbDevice = { deviceId: string; productName?: string; manufacturerName?: string; vendorId?: number; productId?: number; serialNumber?: string };
export type SerialPort = { portId: string; portName: string; displayName?: string; vendorId?: string; productId?: string };
export type HidDevice = { deviceId: string; name?: string; vendorId?: number; productId?: number; serialNumber?: string };
export type BluetoothDevice = { deviceId: string; deviceName?: string };

export const usbItem = (d: UsbDevice): DeviceItem => {
  const id = ids(d.vendorId, d.productId);
  return { deviceId: d.deviceId, label: d.productName || d.manufacturerName || `USB Device ${id}`, detail: withSerial(id, d.serialNumber) };
};
export const serialItem = (p: SerialPort): DeviceItem => ({ deviceId: p.portId, label: `${p.portName} (${p.displayName ?? ""})`, detail: p.vendorId && p.productId ? `${p.vendorId}:${p.productId}` : undefined });
export const hidItem = (d: HidDevice): DeviceItem => {
  const id = ids(d.vendorId, d.productId);
  return { deviceId: d.deviceId, label: d.name || `HID Device ${id}`, detail: withSerial(id, d.serialNumber) };
};
export const bluetoothItem = (d: BluetoothDevice): DeviceItem => ({ deviceId: d.deviceId, label: d.deviceName || d.deviceId, detail: d.deviceId });

export const filterDevices = (devices: DeviceItem[], query: string) => {
  const q = query.trim().toLowerCase();
  return q ? devices.filter((d) => d.label.toLowerCase().includes(q) || (d.detail ?? "").toLowerCase().includes(q)) : devices;
};
