import Foundation
import CoreFoundation
import IOKit.hid

/// Owns a single supported StreamDock HID device. Input callbacks are delivered on the main run loop.
/// `open` and `close` must be called on the main thread. `write` may be called elsewhere.
public final class StreamDockDevice {
    public enum Failure: Error, LocalizedError {
        case notFound, ambiguous, unsupportedReportSize, openFailed(Int32), writeFailed(Int32), notOpen
        public var errorDescription: String? {
            switch self {
            case .notFound: return "지원하는 StreamDock 장치(293S V3, XL)를 찾지 못했습니다."
            case .ambiguous: return "일치하는 StreamDock 인터페이스가 여러 개입니다."
            case .unsupportedReportSize: return "HID 입력 보고서 크기를 확인할 수 없습니다."
            case .openFailed(let code): return "HID 장치를 열지 못했습니다 (\(code))."
            case .writeFailed(let code): return "HID 전송에 실패했습니다 (\(code))."
            case .notOpen: return "HID 장치가 연결되지 않았습니다."
            }
        }
    }
    private var manager: IOHIDManager?
    private var device: IOHIDDevice?
    private let inputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: StreamDockProtocol.reportBytes + 1)
    private let writeQueue = DispatchQueue(label: "streamdock.hid.write")
    public var onEvent: ((StreamDockProtocol.KeyEvent) -> Void)?
    /// USB IDs of the opened device; nil until `open` succeeds.
    public private(set) var usbID: StreamDockProtocol.USBID?
    public var onDeviceAcknowledgement: (() -> Void)?
    public var onRemoval: (() -> Void)?

    public init() { inputBuffer.initialize(repeating: 0, count: StreamDockProtocol.reportBytes + 1) }
    deinit { inputBuffer.deinitialize(count: StreamDockProtocol.reportBytes + 1); inputBuffer.deallocate() }

    public func open() throws {
        precondition(Thread.isMainThread)
        guard device == nil else { return }
        let mgr = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDManagerSetDeviceMatchingMultiple(mgr, StreamDockProtocol.matchingDictionaries() as CFArray)
        // Match hidapi's macOS path: schedule the manager only for discovery.
        // IOHIDManagerOpen would also open every matching interface, including
        // the device's keyboard interface. Open only the selected service.
        IOHIDManagerScheduleWithRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
        _ = CFRunLoopRunInMode(CFRunLoopMode.defaultMode, 0.1, false)
        guard let set = IOHIDManagerCopyDevices(mgr) as? Set<IOHIDDevice> else {
            IOHIDManagerUnscheduleFromRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
            throw Failure.notFound
        }
        let property = { (candidate: IOHIDDevice, key: String) in IOHIDDeviceGetProperty(candidate, key as CFString) as? Int ?? 0 }
        let devices = set.filter { candidate in
            StreamDockProtocol.isSupported(vendorID: property(candidate, kIOHIDVendorIDKey), productID: property(candidate, kIOHIDProductIDKey)) &&
                StreamDockProtocol.isVendorInterface(usagePage: property(candidate, kIOHIDPrimaryUsagePageKey), usage: property(candidate, kIOHIDPrimaryUsageKey))
        }
        guard devices.count == 1, let matched = devices.first else {
            IOHIDManagerUnscheduleFromRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
            throw devices.isEmpty ? Failure.notFound : Failure.ambiguous
        }
        let service = IOHIDDeviceGetService(matched)
        guard service != 0, let selected = IOHIDDeviceCreate(kCFAllocatorDefault, service) else {
            IOHIDManagerUnscheduleFromRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
            throw Failure.notFound
        }
        let result = IOHIDDeviceOpen(selected, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
        guard result == kIOReturnSuccess else {
            IOHIDManagerUnscheduleFromRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
            throw Failure.openFailed(result)
        }
        let inputLength = IOHIDDeviceGetProperty(selected, kIOHIDMaxInputReportSizeKey as CFString) as? Int ?? 0
        guard (1...(StreamDockProtocol.reportBytes + 1)).contains(inputLength) else {
            IOHIDDeviceClose(selected, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
            IOHIDManagerUnscheduleFromRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
            throw Failure.unsupportedReportSize
        }
        manager = mgr
        device = selected
        usbID = .init(vendorID: property(matched, kIOHIDVendorIDKey), productID: property(matched, kIOHIDProductIDKey))
        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDDeviceRegisterInputReportCallback(selected, inputBuffer, inputLength, { context, result, _, _, _, report, reportLength in
            guard result == kIOReturnSuccess, let context, reportLength > 0 else { return }
            let owner = Unmanaged<StreamDockDevice>.fromOpaque(context).takeUnretainedValue()
            let bytes = Data(bytes: report, count: reportLength)
            if StreamDockProtocol.isDeviceAcknowledgement(bytes) { owner.onDeviceAcknowledgement?(); return }
            if let event = StreamDockProtocol.keyEvent(bytes) { owner.onEvent?(event) }
        }, context)
        IOHIDDeviceRegisterRemovalCallback(selected, { context, _, _ in
            guard let context else { return }
            let owner = Unmanaged<StreamDockDevice>.fromOpaque(context).takeUnretainedValue()
            owner.onRemoval?()
        }, context)
        IOHIDDeviceScheduleWithRunLoop(selected, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
    }

    /// Serializes all HID transfers and removes the node-hid leading report ID.
    public func write(_ packet: Data) throws {
        let payload = try StreamDockProtocol.ioKitPayload(packet)
        try writeQueue.sync {
            guard let device else { throw Failure.notOpen }
            let result = payload.withUnsafeBytes { bytes in
                IOHIDDeviceSetReport(device, kIOHIDReportTypeOutput, 0, bytes.bindMemory(to: UInt8.self).baseAddress!, payload.count)
            }
            guard result == kIOReturnSuccess else { throw Failure.writeFailed(result) }
        }
    }

    public func close() {
        precondition(Thread.isMainThread)
        writeQueue.sync {
            if let device {
                IOHIDDeviceUnscheduleFromRunLoop(device, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
                IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
            }
            if let manager { IOHIDManagerUnscheduleFromRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue) }
            device = nil; manager = nil; usbID = nil
        }
    }
}
