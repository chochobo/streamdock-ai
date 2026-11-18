import XCTest
@testable import StreamDockHID
final class ProtocolTests: XCTestCase {
    func testCommandMatchesExistingNodeWireFormat() throws {
        let p = try Protocol293S.command([0x53, 0x54, 0x50])
        XCTAssertEqual(p.count, 1025)
        XCTAssertEqual(Array(p.prefix(9)), [0, 0x43, 0x52, 0x54, 0, 0, 0x53, 0x54, 0x50])
        XCTAssertEqual(try Protocol293S.ioKitPayload(p).count, 1024)
        XCTAssertThrowsError(try Protocol293S.command(Array(repeating: 0, count: 1020)))
    }
    func testImageSegmentationAndSlots() throws {
        let data = Data(repeating: 7, count: 1025)
        let p = try Protocol293S.imagePackets(id: 13, jpeg: data)
        XCTAssertEqual(p.count, 4)
        XCTAssertEqual(Array(p[0][9...13]), [0, 0, 4, 1, 13])
        XCTAssertEqual(p[1].count, 1025)
        XCTAssertEqual(p[2][1], 7); XCTAssertEqual(p[2][2], 0)
        XCTAssertThrowsError(try Protocol293S.imagePackets(id: 1, jpeg: Data(repeating: 7, count: 10241)))
        XCTAssertThrowsError(try Protocol293S.imagePackets(id: 19, jpeg: data))
    }
    func testInputMappingAndMalformedEvents() {
        var event = Data([0x41, 0x43, 0x4b, 0, 0, 0x4f, 0x4b, 0, 0, 13, 1])
        XCTAssertEqual(Protocol293S.keyEvent(event), .init(index: 0, pressed: true))
        event[10] = 0; XCTAssertEqual(Protocol293S.keyEvent(event), .init(index: 0, pressed: false))
        event[9] = 3; XCTAssertEqual(Protocol293S.keyEvent(event), .init(index: 14, pressed: false))
        event[10] = 2; XCTAssertNil(Protocol293S.keyEvent(event))
        XCTAssertNil(Protocol293S.keyEvent(Data([0])))
    }
    func testNonZeroDataSliceIndices() throws {
        let storage = Data(repeating: 0xaa, count: 2) + Data(repeating: 7, count: 1025)
        let slice = storage.dropFirst(2)
        let packets = try Protocol293S.imagePackets(id: 13, jpeg: slice)
        XCTAssertEqual(packets[1][1], 7)
        let eventStorage = Data([0xff, 0x41, 0x43, 0x4b, 0, 0, 0x4f, 0x4b, 0, 0, 13, 1])
        XCTAssertEqual(Protocol293S.keyEvent(eventStorage.dropFirst()), .init(index: 0, pressed: true))
    }
    func testDeviceAcknowledgementIsDistinctFromKey() {
        let packet = Data([0x41,0x43,0x4b,0,0,0x4f,0x4b,0,0,0xff])
        XCTAssertTrue(Protocol293S.isDeviceAcknowledgement(packet))
        XCTAssertNil(Protocol293S.keyEvent(packet))
        XCTAssertFalse(Protocol293S.isDeviceAcknowledgement(Data([0])))
    }
    func testRejectsInvalidIOKitPackets() {
        XCTAssertThrowsError(try Protocol293S.ioKitPayload(Data(repeating: 0, count: 1024)))
        var nonzero = Data(repeating: 0, count: 1025); nonzero[0] = 1
        XCTAssertThrowsError(try Protocol293S.ioKitPayload(nonzero))
    }
}
