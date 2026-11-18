import Foundation
import CoreFoundation
import IOKit.hid

/// Owns a single 293sV3 HID device. Input callbacks are delivered on the main run loop.
/// `open` and `close` must be called on the main thread. `write` may be called elsewhere.
public final class Device293S {
    public enum Failure: Error, LocalizedError {
        case notFound, ambiguous, unsupportedReportSize, openFailed(Int32), writeFailed(Int32), notOpen
        public var errorDescription: String? {
            switch self {
            case .notFound: return "293sV3 장치를 찾지 못했습니다."
            case .ambiguous: return "일치하는 293sV3 인터페이스가 여러 개입니다."
            case .unsupportedReportSize: return "HID 입력 보고서 크기를 확인할 수 없습니다."
            case .openFailed(let code): return "HID 장치를 열지 못했습니다 (\(code))."
            case .writeFailed(let code): return "HID 전송에 실패했습니다 (\(code))."
            case .notOpen: return "HID 장치가 연결되지 않았습니다."
            }
        }
    }
    private var manager: IOHIDManager?
    private var device: IOHIDDevice?
    private let inputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: Protocol293S.reportBytes + 1)
    private let writeQueue = DispatchQueue(label: "streamdock.hid.write")
    public var onEvent: ((Protocol293S.KeyEvent) -> Void)?
    public var onDeviceAcknowledgement: (() -> Void)?
    public var onRemoval: (() -> Void)?

    public init() { inputBuffer.initialize(repeating: 0, count: Protocol293S.reportBytes + 1) }
    deinit { inputBuffer.deinitialize(count: Protocol293S.reportBytes + 1); inputBuffer.deallocate() }

    public func open() throws {
        precondition(Thread.isMainThread)
        guard device == nil else { return }
        let mgr = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        let matching: [String: Int] = [kIOHIDVendorIDKey as String: Protocol293S.vendorID, kIOHIDProductIDKey as String: Protocol293S.productID]
        IOHIDManagerSetDeviceMatching(mgr, matching as CFDictionary)
        // Match hidapi's macOS path: schedule the manager only for discovery.
        // IOHIDManagerOpen would also open every matching interface, including
        // the device's keyboard interface. Open only the selected service.
        IOHIDManagerScheduleWithRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
        _ = CFRunLoopRunInMode(CFRunLoopMode.defaultMode, 0.1, false)
        guard let set = IOHIDManagerCopyDevices(mgr) as? Set<IOHIDDevice> else {
            IOHIDManagerUnscheduleFromRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
            throw Failure.notFound
        }
        let devices = set.filter { candidate in
            let page = IOHIDDeviceGetProperty(candidate, kIOHIDPrimaryUsagePageKey as CFString) as? Int ?? 0
            let usage = IOHIDDeviceGetProperty(candidate, kIOHIDPrimaryUsageKey as CFString) as? Int ?? 0
            return page > 1025 && usage == 1
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
        guard (1...(Protocol293S.reportBytes + 1)).contains(inputLength) else {
            IOHIDDeviceClose(selected, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
            IOHIDManagerUnscheduleFromRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
            throw Failure.unsupportedReportSize
        }
        manager = mgr
        device = selected
        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDDeviceRegisterInputReportCallback(selected, inputBuffer, inputLength, { context, result, _, _, _, report, reportLength in
            guard result == kIOReturnSuccess, let context, reportLength > 0 else { return }
            let owner = Unmanaged<Device293S>.fromOpaque(context).takeUnretainedValue()
            let bytes = Data(bytes: report, count: reportLength)
            if Protocol293S.isDeviceAcknowledgement(bytes) { owner.onDeviceAcknowledgement?(); return }
            if let event = Protocol293S.keyEvent(bytes) { owner.onEvent?(event) }
        }, context)
        IOHIDDeviceRegisterRemovalCallback(selected, { context, _, _ in
            guard let context else { return }
            let owner = Unmanaged<Device293S>.fromOpaque(context).takeUnretainedValue()
            owner.onRemoval?()
        }, context)
        IOHIDDeviceScheduleWithRunLoop(selected, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
    }

    /// Serializes all HID transfers and removes the node-hid leading report ID.
    public func write(_ packet: Data) throws {
        let payload = try Protocol293S.ioKitPayload(packet)
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
            device = nil; manager = nil
        }
    }
}
