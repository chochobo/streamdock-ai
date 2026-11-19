import Foundation
import StreamDockHID

// One helper owns HID; the parent owns higher-level rendering and key semantics.
// The helper emits only protocol JSON on stdout. Diagnostics go to stderr.
struct Request: Decodable { let id: Int; let packet: String }
let outputLock = NSLock()
func emit(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj), let bytes = try? JSONSerialization.data(withJSONObject: obj),
          var line = String(data: bytes, encoding: .utf8) else { return }
    line += "\n"
    outputLock.lock(); defer { outputLock.unlock() }
    FileHandle.standardOutput.write(Data(line.utf8))
}
let simulator = CommandLine.arguments.contains("--simulate")
let device = StreamDockDevice()
if !simulator {
    do {
        try device.open()
        device.onEvent = { event in emit(["event": "key", "code": Int(event.code), "pressed": event.pressed]) }
        device.onDeviceAcknowledgement = { emit(["event": "device-ack"]) }
        device.onRemoval = {
            emit(["event": "error", "message": "장치 연결이 끊어졌습니다."])
            device.close()
            exit(1)
        }
    } catch {
        emit(["event": "error", "message": error.localizedDescription])
        exit(1)
    }
}
// The simulator reports a 293S V3 so the parent can choose a key layout.
let usbID = simulator ? StreamDockProtocol.supportedDevices[0] : device.usbID
guard let usbID else {
    emit(["event": "error", "message": StreamDockDevice.Failure.notFound.localizedDescription])
    exit(1)
}
emit(["event": "ready", "simulated": simulator, "vendorId": usbID.vendorID, "productId": usbID.productID])
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard line.utf8.count <= 5000,
              let data = line.data(using: .utf8), let request = try? JSONDecoder().decode(Request.self, from: data),
              request.id >= 0, let packet = Data(base64Encoded: request.packet) else {
            emit(["event": "error", "message": "잘못된 HID 요청입니다."])
            DispatchQueue.main.async { if !simulator { device.close() }; exit(1) }
            return
        }
        do {
            _ = try StreamDockProtocol.ioKitPayload(packet)
            if !simulator { try device.write(packet) }
            emit(["id": request.id, "ok": true])
        } catch {
            emit(["id": request.id, "ok": false, "message": error.localizedDescription])
            DispatchQueue.main.async { if !simulator { device.close() }; exit(1) }
            return
        }
    }
    DispatchQueue.main.async { if !simulator { device.close() }; exit(0) }
}
RunLoop.main.run()
