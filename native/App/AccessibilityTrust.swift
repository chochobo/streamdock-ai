import AppKit
import ApplicationServices
import Combine

/// Reads this app's current macOS Accessibility trust without requesting it.
@MainActor
final class AccessibilityTrustMonitor: ObservableObject {
    @Published private(set) var isTrusted: Bool
    private let query: () -> Bool
    private let center: NotificationCenter
    private var observer: NSObjectProtocol?

    init(query: @escaping () -> Bool = { AXIsProcessTrusted() }, center: NotificationCenter = .default) {
        self.query = query
        self.center = center
        self.isTrusted = query()
        observer = center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() {
        isTrusted = query()
    }

    deinit {
        if let observer { center.removeObserver(observer) }
    }
}
