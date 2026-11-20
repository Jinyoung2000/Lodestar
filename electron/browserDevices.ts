import { randomUUID } from "node:crypto";
import type { Session, WebContents } from "electron";
import { bluetoothItem, hidItem, serialItem, usbItem, type DeviceItem, type DeviceRequest, type DeviceType } from "../web/browserDevices";
import { permissionOrigin } from "../web/browserPermissions";


type Pending = { requestId: string; guest: WebContents | null; origin: string; deviceType: DeviceType; devices: DeviceItem[]; settled: boolean; invoke: (deviceId: string | null) => void };

export class DeviceRequests {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly emit: (request: DeviceRequest, guest: WebContents | null) => boolean,
    private readonly allowed: (origin: string) => boolean,
  ) {}

  // 요청 하나를 시작한다. 화면에 보내지 못하면(창이 없음) 바로 취소한다. 요청 id 를 돌려준다.
  begin(input: { guest: WebContents | null; origin: string; deviceType: DeviceType; devices: DeviceItem[]; invoke: (deviceId: string | null) => void }): string | null {
    if (!input.origin || !this.allowed(input.origin)) {
      input.invoke(null);
      return null;
    }
    const requestId = randomUUID();
    const done = () => settle(null);
    const settle = (deviceId: string | null) => {
      if (entry.settled) return;
      entry.settled = true;
      input.guest?.off("destroyed", done);
      this.pending.delete(requestId);
      input.invoke(deviceId);
    };
    const entry: Pending = { requestId, guest: input.guest, origin: input.origin, deviceType: input.deviceType, devices: input.devices, settled: false, invoke: settle };
    input.guest?.on("destroyed", done);
    this.pending.set(requestId, entry);
    if (!this.send(entry)) done();
    return requestId;
  }

  private send(entry: Pending) {
    return this.emit({ requestId: entry.requestId, origin: entry.origin, deviceType: entry.deviceType, devices: entry.devices }, entry.guest);
  }

  // 화면이 고른 기기(취소는 null)
  resolve(requestId: string, deviceId: string | null) {
    const entry = this.pending.get(requestId);
    if (entry && (deviceId === null || entry.devices.some((d) => d.deviceId === deviceId))) entry.invoke(deviceId);
  }

  add(guest: WebContents | null, type: DeviceType, device: DeviceItem) {
    const entry = this.active(guest, type);
    if (!entry || entry.devices.some((d) => d.deviceId === device.deviceId)) return;
    entry.devices = [...entry.devices, device];
    this.send(entry);
  }

  remove(guest: WebContents | null, type: DeviceType, deviceId: string) {
    const entry = this.active(guest, type);
    if (!entry) return;
    const next = entry.devices.filter((d) => d.deviceId !== deviceId);
    if (next.length === entry.devices.length) return;
    entry.devices = next;
    this.send(entry);
  }

  private active(guest: WebContents | null, type: DeviceType) {
    for (const entry of this.pending.values()) if (!entry.settled && entry.guest === guest && entry.deviceType === type) return entry;
    return undefined;
  }

  // 요청이 열려 있는 동안 블루투스 목록이 다시 오면 기존 요청의 목록과 응답 함수를 바꾼다(같은 선택창을 갱신).
  replaceBluetooth(guest: WebContents, devices: DeviceItem[], invoke: (deviceId: string | null) => void): boolean {
    const entry = this.active(guest, "bluetooth");
    if (!entry) return false;
    entry.devices = devices;
    entry.invoke = (id) => {
      entry.settled = true;
      this.pending.delete(entry.requestId);
      invoke(id);
    };
    this.send(entry);
    return true;
  }

  closeFor(guest: WebContents) {
    for (const entry of [...this.pending.values()]) if (entry.guest === guest) entry.invoke(null);
  }
}

type Frame = { url?: string } | null | undefined;
type FrameInfo = { frame?: Frame };

// 이 세션의 기기 요청 이벤트를 DeviceRequests 로 잇는다. 블루투스는 세션이 아니라 webContents 의 이벤트라 bindBluetooth 로 따로 건다.
export function bindDeviceSession(ses: Session, requests: DeviceRequests, fromFrame: (frame: Frame) => WebContents | null) {
  const originOf = (guest: WebContents | null, frame?: Frame) => permissionOrigin(frame?.url || guest?.getURL() || "");
  const sessionOn = ses as unknown as { on(event: string, listener: (...args: any[]) => void): void };
  sessionOn.on("select-usb-device", (event: Electron.Event, details: { deviceList: Parameters<typeof usbItem>[0][] } & FrameInfo, callback: (id?: string) => void) => {
    event.preventDefault();
    const guest = fromFrame(details.frame);
    requests.begin({ guest, origin: originOf(guest, details.frame), deviceType: "usb", devices: details.deviceList.map(usbItem), invoke: (id) => (id === null ? callback() : callback(id)) });
  });
  sessionOn.on("usb-device-added", (_e: Electron.Event, device: Parameters<typeof usbItem>[0], guest: WebContents) => requests.add(guest, "usb", usbItem(device)));
  sessionOn.on("usb-device-removed", (_e: Electron.Event, device: { deviceId: string }, guest: WebContents) => requests.remove(guest, "usb", device.deviceId));
  sessionOn.on("select-serial-port", (event: Electron.Event, ports: Parameters<typeof serialItem>[0][], guest: WebContents, callback: (id: string) => void) => {
    event.preventDefault();
    requests.begin({ guest, origin: originOf(guest), deviceType: "serial", devices: ports.map(serialItem), invoke: (id) => callback(id ?? "") });
  });
  sessionOn.on("serial-port-added", (_e: Electron.Event, port: Parameters<typeof serialItem>[0], guest: WebContents) => requests.add(guest, "serial", serialItem(port)));
  sessionOn.on("serial-port-removed", (_e: Electron.Event, port: { portId: string }, guest: WebContents) => requests.remove(guest, "serial", port.portId));
  sessionOn.on("select-hid-device", (event: Electron.Event, details: { deviceList: Parameters<typeof hidItem>[0][] } & FrameInfo, callback: (id?: string | null) => void) => {
    event.preventDefault();
    const guest = fromFrame(details.frame);
    requests.begin({ guest, origin: originOf(guest, details.frame), deviceType: "hid", devices: details.deviceList.map(hidItem), invoke: (id) => callback(id ?? null) });
  });
  sessionOn.on("hid-device-added", (_e: Electron.Event, details: { device: Parameters<typeof hidItem>[0] } & FrameInfo) => {
    const guest = fromFrame(details.frame);
    if (guest) requests.add(guest, "hid", hidItem(details.device));
  });
  sessionOn.on("hid-device-removed", (_e: Electron.Event, details: { device: { deviceId: string } } & FrameInfo) => {
    const guest = fromFrame(details.frame);
    if (guest) requests.remove(guest, "hid", details.device.deviceId);
  });
}

export function bindBluetooth(guest: WebContents, requests: DeviceRequests) {
  guest.on("select-bluetooth-device", (event, list, callback) => {
    event.preventDefault();
    const devices = list.map(bluetoothItem);
    if (requests.replaceBluetooth(guest, devices, (id) => callback(id ?? ""))) return;
    requests.begin({ guest, origin: permissionOrigin(guest.getURL()), deviceType: "bluetooth", devices, invoke: (id) => callback(id ?? "") });
  });
  guest.once("destroyed", () => requests.closeFor(guest));
}
