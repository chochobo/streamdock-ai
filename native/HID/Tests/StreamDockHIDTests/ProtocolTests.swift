import XCTest
@testable import StreamDockHID
final class ProtocolTests: XCTestCase {
    func testCommandMatchesExistingNodeWireFormat() throws {
        let p = try StreamDockProtocol.command([0x53, 0x54, 0x50])
        XCTAssertEqual(p.count, 1025)
        XCTAssertEqual(Array(p.prefix(9)), [0, 0x43, 0x52, 0x54, 0, 0, 0x53, 0x54, 0x50])
        XCTAssertEqual(try StreamDockProtocol.ioKitPayload(p).count, 1024)
        XCTAssertThrowsError(try StreamDockProtocol.command(Array(repeating: 0, count: 1020)))
    }
    func testImageSegmentationAndSlots() throws {
        let data = Data(repeating: 7, count: 1025)
        let p = try StreamDockProtocol.imagePackets(id: 13, jpeg: data)
        XCTAssertEqual(p.count, 4)
        XCTAssertEqual(Array(p[0][9...13]), [0, 0, 4, 1, 13])
        XCTAssertEqual(p[1].count, 1025)
        XCTAssertEqual(p[2][1], 7); XCTAssertEqual(p[2][2], 0)
        XCTAssertThrowsError(try StreamDockProtocol.imagePackets(id: 1, jpeg: Data(repeating: 7, count: 10241)))
        // XL uses image slots 1...32.
        XCTAssertEqual(try StreamDockProtocol.imagePackets(id: 32, jpeg: data)[0][13], 32)
        XCTAssertThrowsError(try StreamDockProtocol.imagePackets(id: 0, jpeg: data))
        XCTAssertThrowsError(try StreamDockProtocol.imagePackets(id: 33, jpeg: data))
    }
    func testInputCodesAndMalformedEvents() {
        var event = Data([0x41, 0x43, 0x4b, 0, 0, 0x4f, 0x4b, 0, 0, 13, 1])
        XCTAssertEqual(StreamDockProtocol.keyEvent(event), .init(code: 13, pressed: true))
        event[10] = 0; XCTAssertEqual(StreamDockProtocol.keyEvent(event), .init(code: 13, pressed: false))
        event[9] = 0x01; XCTAssertEqual(StreamDockProtocol.keyEvent(event), .init(code: 0x01, pressed: false))
        event[9] = 0x26; XCTAssertEqual(StreamDockProtocol.keyEvent(event), .init(code: 0x26, pressed: false))
        event[9] = 0x27; XCTAssertNil(StreamDockProtocol.keyEvent(event))
        event[9] = 0x00; XCTAssertNil(StreamDockProtocol.keyEvent(event))
        event[9] = 3; event[10] = 2; XCTAssertNil(StreamDockProtocol.keyEvent(event))
        event[10] = 1
        for offset in [0, 1, 2, 5, 6] {
            var invalid = event; invalid[offset] ^= 0xff
            XCTAssertNil(StreamDockProtocol.keyEvent(invalid))
        }
        XCTAssertNil(StreamDockProtocol.keyEvent(Data([0])))
    }
    func testNonZeroDataSliceIndices() throws {
        let storage = Data(repeating: 0xaa, count: 2) + Data(repeating: 7, count: 1025)
        let slice = storage.dropFirst(2)
        let packets = try StreamDockProtocol.imagePackets(id: 13, jpeg: slice)
        XCTAssertEqual(packets[1][1], 7)
        let eventStorage = Data([0xff, 0x41, 0x43, 0x4b, 0, 0, 0x4f, 0x4b, 0, 0, 13, 1])
        XCTAssertEqual(StreamDockProtocol.keyEvent(eventStorage.dropFirst()), .init(code: 13, pressed: true))
    }
    func testDeviceAcknowledgementIsDistinctFromKey() {
        let packet = Data([0x41,0x43,0x4b,0,0,0x4f,0x4b,0,0,0xff])
        XCTAssertTrue(StreamDockProtocol.isDeviceAcknowledgement(packet))
        XCTAssertNil(StreamDockProtocol.keyEvent(packet))
        XCTAssertNil(StreamDockProtocol.keyEvent(packet + Data([1])))
        XCTAssertFalse(StreamDockProtocol.isDeviceAcknowledgement(Data([0])))
    }
    func testRejectsInvalidIOKitPackets() {
        XCTAssertThrowsError(try StreamDockProtocol.ioKitPayload(Data(repeating: 0, count: 1024)))
        var nonzero = Data(repeating: 0, count: 1025); nonzero[0] = 1
        XCTAssertThrowsError(try StreamDockProtocol.ioKitPayload(nonzero))
    }
    func testSupportedDeviceListAndInterfaceFilter() {
        XCTAssertTrue(StreamDockProtocol.isSupported(vendorID: 0x6603, productID: 0x1014))
        XCTAssertTrue(StreamDockProtocol.isSupported(vendorID: 0x5548, productID: 0x1028))
        XCTAssertTrue(StreamDockProtocol.isSupported(vendorID: 0x5548, productID: 0x1031))
        XCTAssertFalse(StreamDockProtocol.isSupported(vendorID: 0x6603, productID: 0x1028))
        XCTAssertFalse(StreamDockProtocol.isSupported(vendorID: 0x5548, productID: 0x1014))
        XCTAssertEqual(StreamDockProtocol.matchingDictionaries(), [
            ["VendorID": 0x6603, "ProductID": 0x1014],
            ["VendorID": 0x5548, "ProductID": 0x1028],
            ["VendorID": 0x5548, "ProductID": 0x1031],
        ])
        XCTAssertTrue(StreamDockProtocol.isVendorInterface(usagePage: 0xff00, usage: 1))
        XCTAssertFalse(StreamDockProtocol.isVendorInterface(usagePage: 1, usage: 6))
        XCTAssertFalse(StreamDockProtocol.isVendorInterface(usagePage: 0xff00, usage: 2))
    }
}
