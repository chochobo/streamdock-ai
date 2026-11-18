import AppKit
import Foundation

@main
struct AccessibilityTrustTests {
    @MainActor
    static func main() async {
        let center = NotificationCenter()
        var trusted = false
        var reads = 0
        let monitor = AccessibilityTrustMonitor(query: {
            reads += 1
            return trusted
        }, center: center)
        precondition(!monitor.isTrusted && reads == 1, "initial trust must come from the injected query")
        trusted = true
        center.post(name: NSApplication.didBecomeActiveNotification, object: nil)
        for _ in 0..<100 where !monitor.isTrusted { await Task.yield() }
        precondition(monitor.isTrusted && reads >= 2, "foreground notification must refresh trust")
        trusted = false
        monitor.refresh()
        precondition(!monitor.isTrusted, "explicit refresh must reflect a revoked permission")
        print("Accessibility trust monitor tests passed")
    }
}
