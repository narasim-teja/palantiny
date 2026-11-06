// palantiny sensor: passively listens to public Bluetooth LE and Wi-Fi broadcasts and
// streams them as JSON lines over a Unix socket to the server.
//
// It never connects to a device and never captures traffic. It stores nothing itself,
// and exits as soon as the server goes away so nothing is left scanning.

import AppKit
import CoreBluetooth
import CoreLocation
import CoreWLAN
import Foundation

// MARK: Output

final class Output {
  private let fd: Int32
  private let queue = DispatchQueue(label: "palantiny.output")

  init?(path: String) {
    signal(SIGPIPE, SIG_IGN)
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    let bytes = Array(path.utf8)
    guard bytes.count < capacity else { return nil }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let ok = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
    }
    guard ok == 0 else { return nil }
    watchForClose()
  }

  func send(_ event: [String: Any]) {
    guard let body = try? JSONSerialization.data(withJSONObject: event) else { return }
    queue.async {
      var line = body
      line.append(0x0A)
      let sent = line.withUnsafeBytes { write(self.fd, $0.baseAddress, line.count) }
      if sent < 0 { exit(0) }
    }
  }

  // The server never writes back, so a readable socket means it has closed.
  private func watchForClose() {
    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    source.setEventHandler { exit(0) }
    source.resume()
    retained = source
  }
  private var retained: DispatchSourceRead?
}

func now() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

// MARK: Bluetooth

final class Bluetooth: NSObject, CBCentralManagerDelegate {
  private let out: Output
  private var manager: CBCentralManager!
  private var lastSent = [UUID: (at: Date, payload: Data?)]()
  private let queue = DispatchQueue(label: "palantiny.ble")
  private let minInterval: TimeInterval = 2

  init(out: Output) {
    self.out = out
    super.init()
    manager = CBCentralManager(delegate: self, queue: queue)
  }

  var stateName: String {
    switch manager.state {
    case .poweredOn: return "on"
    case .poweredOff: return "off"
    case .unauthorized: return "denied"
    case .unsupported: return "unsupported"
    default: return "starting"
    }
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    out.send(["t": "status", "ts": now(), "bluetooth": stateName])
    if central.state == .poweredOn {
      central.scanForPeripherals(
        withServices: nil,
        options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    }
  }

  func centralManager(
    _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
    advertisementData ad: [String: Any], rssi: NSNumber
  ) {
    let value = rssi.intValue
    guard value < 0 else { return }  // 127 means the radio had no reading.

    let id = peripheral.identifier
    let payload = ad[CBAdvertisementDataManufacturerDataKey] as? Data
    let date = Date()
    if let last = lastSent[id], last.payload == payload,
      date.timeIntervalSince(last.at) < minInterval
    {
      return
    }
    lastSent[id] = (date, payload)
    if lastSent.count > 20000 { lastSent.removeAll() }

    var event: [String: Any] = ["t": "ble", "ts": now(), "id": id.uuidString, "rssi": value]
    if let name = (ad[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name {
      event["name"] = name
    }
    if let payload { event["mfr"] = payload.map { String(format: "%02x", $0) }.joined() }
    if let services = ad[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID], !services.isEmpty {
      event["svc"] = services.map(\.uuidString)
    }
    out.send(event)
  }
}

// MARK: Wi-Fi

final class WiFi: NSObject, CLLocationManagerDelegate {
  private let out: Output
  private let location = CLLocationManager()
  private let queue = DispatchQueue(label: "palantiny.wifi")
  private let interval: TimeInterval = 45

  init(out: Output) {
    self.out = out
    super.init()
    location.delegate = self
    location.requestWhenInUseAuthorization()
    location.startUpdatingLocation()  // Needed to unlock Wi-Fi names. Coordinates are ignored.
    queue.async { self.loop() }
  }

  private var locationName: String {
    switch location.authorizationStatus {
    case .authorizedAlways: return "allowed"
    case .denied, .restricted: return "denied"
    default: return "waiting"
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    out.send(["t": "status", "ts": now(), "location": locationName])
    queue.async { self.scan() }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {}

  private func loop() {
    scan()
    queue.asyncAfter(deadline: .now() + interval) { self.loop() }
  }

  private func scan() {
    guard let wifi = CWWiFiClient.shared().interface() else {
      out.send(["t": "status", "ts": now(), "wifi": "missing"])
      return
    }
    guard wifi.powerOn() else {
      out.send(["t": "status", "ts": now(), "wifi": "off"])
      return
    }
    guard let found = try? wifi.scanForNetworks(withSSID: nil) else { return }
    let nets: [[String: Any]] = found.map { net in
      var row: [String: Any] = [
        "rssi": net.rssiValue,
        "secured": !net.supportsSecurity(.none),
      ]
      if let ssid = net.ssid { row["ssid"] = ssid }
      if let bssid = net.bssid { row["bssid"] = bssid }
      if let channel = net.wlanChannel {
        row["channel"] = channel.channelNumber
        row["band"] = channel.channelBand.rawValue
      }
      return row
    }
    out.send(["t": "wifi", "ts": now(), "nets": nets])
    out.send(["t": "status", "ts": now(), "wifi": "on", "location": locationName])
  }
}

// MARK: Entry

let args = CommandLine.arguments
guard let flag = args.firstIndex(of: "--socket"), flag + 1 < args.count,
  let out = Output(path: args[flag + 1])
else {
  FileHandle.standardError.write(Data("sensor: could not reach server socket\n".utf8))
  exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
out.send(["t": "hello", "ts": now(), "v": 1])
let bluetooth = Bluetooth(out: out)
let wifi = WiFi(out: out)
app.run()
