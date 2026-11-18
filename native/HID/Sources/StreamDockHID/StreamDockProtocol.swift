import Foundation

/// Wire format shared by the supported StreamDock models (293S V3, XL), including
/// the zero report-ID byte used by node-hid. Model-specific key layouts live in Node.
public enum StreamDockProtocol {
    public struct USBID: Hashable {
        public let vendorID: Int
        public let productID: Int
        public init(vendorID: Int, productID: Int) { self.vendorID = vendorID; self.productID = productID }
    }
    /// 293S V3, XL (Chinese edition), XL (international edition).
    public static let supportedDevices: [USBID] = [
        USBID(vendorID: 0x6603, productID: 0x1014),
        USBID(vendorID: 0x5548, productID: 0x1028),
        USBID(vendorID: 0x5548, productID: 0x1031),
    ]
    public static let reportBytes = 1024
    public static let maxImageSlot = 32
    /// Key and rocker input codes; Node decides which ones are keys for the model.
    public static let inputCodes: ClosedRange<UInt8> = 0x01...0x26

    public enum Failure: Error, Equatable { case invalidCommand, invalidImage, invalidPacket }
    public struct KeyEvent: Equatable {
        public let code: UInt8
        public let pressed: Bool
        public init(code: UInt8, pressed: Bool) { self.code = code; self.pressed = pressed }
    }

    public static func isSupported(vendorID: Int, productID: Int) -> Bool {
        supportedDevices.contains(USBID(vendorID: vendorID, productID: productID))
    }

    /// The vendor interface: hidapi reports it with usage page > 1025 and usage 1.
    public static func isVendorInterface(usagePage: Int, usage: Int) -> Bool {
        usagePage > 1025 && usage == 1
    }

    /// IOHIDManager matching dictionaries for every supported device
    /// ("VendorID" / "ProductID" are the values of kIOHIDVendorIDKey / kIOHIDProductIDKey).
    public static func matchingDictionaries() -> [[String: Int]] {
        supportedDevices.map { ["VendorID": $0.vendorID, "ProductID": $0.productID] }
    }

    public static func command(_ bytes: [UInt8]) throws -> Data {
        guard bytes.count + 5 <= reportBytes else { throw Failure.invalidCommand }
        var packet = Data(repeating: 0, count: reportBytes + 1)
        packet.replaceSubrange(1..<6, with: [0x43, 0x52, 0x54, 0, 0])
        packet.replaceSubrange(6..<(6 + bytes.count), with: bytes)
        return packet
    }

    public static func imagePackets(id: Int, jpeg: Data) throws -> [Data] {
        guard (1...maxImageSlot).contains(id), !jpeg.isEmpty, jpeg.count <= 10_240 else { throw Failure.invalidImage }
        let count = UInt32(jpeg.count)
        let header: [UInt8] = [0x42, 0x41, 0x54, UInt8((count >> 24) & 0xff), UInt8((count >> 16) & 0xff), UInt8((count >> 8) & 0xff), UInt8(count & 0xff), UInt8(id)]
        var packets = [try command(header)]
        for offset in stride(from: 0, to: jpeg.count, by: reportBytes) {
            var packet = Data(repeating: 0, count: reportBytes + 1)
            let end = min(offset + reportBytes, jpeg.count)
            let startIndex = jpeg.index(jpeg.startIndex, offsetBy: offset)
            let endIndex = jpeg.index(jpeg.startIndex, offsetBy: end)
            packet.replaceSubrange(1..<(1 + end - offset), with: jpeg[startIndex..<endIndex])
            packets.append(packet)
        }
        packets.append(try command([0x53, 0x54, 0x50]))
        return packets
    }

    /// IOKit takes a separate report ID. Like hidapi, omit a leading zero ID from payload.
    public static func ioKitPayload(_ packet: Data) throws -> Data {
        guard packet.count == reportBytes + 1, packet.first == 0 else { throw Failure.invalidPacket }
        return Data(packet.dropFirst())
    }

    /// The vendor SDK recognizes byte 9 == 0xff as a write-confirmation report.
    /// It is a diagnostic signal and does not prove that a specific frame is visible.
    public static func isDeviceAcknowledgement(_ data: Data) -> Bool {
        data.count >= 10 && data[data.index(data.startIndex, offsetBy: 9)] == 0xff
    }

    public static func keyEvent(_ data: Data) -> KeyEvent? {
        guard data.count >= 11 else { return nil }
        let bytes = Array(data.prefix(11))
        guard bytes[0] == 0x41, bytes[1] == 0x43, bytes[2] == 0x4b,
              bytes[5] == 0x4f, bytes[6] == 0x4b, bytes[10] == 0 || bytes[10] == 1,
              inputCodes.contains(bytes[9]) else { return nil }
        return KeyEvent(code: bytes[9], pressed: bytes[10] == 1)
    }
}
