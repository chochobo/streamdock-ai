// Read only Claude Desktop's weekly usage popup accessibility label.
// This process does not prompt for permission, activate the app or read chat text.
import AppKit
import ApplicationServices
import Foundation

struct Result: Encodable { let status: String; let badges: [String] }
func emit(_ status: String, _ badges: [String] = []) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(Result(status: status, badges: badges)),
       let string = String(data: data, encoding: .utf8) { print(string) }
}
func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}
func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
    guard let value = attribute(element, name) else { return nil }
    return value as? String
}
func elements(_ element: AXUIElement, _ name: CFString) -> [AXUIElement] {
    guard let value = attribute(element, name) else { return [] }
    return value as? [AXUIElement] ?? []
}
func isWeeklyUsageBadge(_ value: String) -> Bool {
    let lower = value.lowercased()
    let korean = value.contains("사용량") && value.contains("주간") && value.contains("모든 모델")
    let english = lower.contains("usage") && lower.contains("week") && lower.contains("all models")
    return (korean || english) && value.contains("%") && value.utf8.count <= 512
}

guard AXIsProcessTrusted() else { emit("permission_required"); exit(0) }
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop")
    .filter { !$0.isTerminated }
guard apps.count == 1, let app = apps.first else {
    emit(apps.isEmpty ? "not_running" : "ambiguous_application"); exit(0)
}
let root = AXUIElementCreateApplication(app.processIdentifier)
_ = AXUIElementSetMessagingTimeout(root, 0.15)
var stack = elements(root, kAXWindowsAttribute as CFString)
var badges = Set<String>()
var visited = 0
let deadline = Date().addingTimeInterval(4)
let leaves: Set<String> = ["AXStaticText", "AXTextArea", "AXTextField", "AXImage", "AXLink", "AXButton", "AXCheckBox", "AXRadioButton", "AXMenuItem"]
while let item = stack.popLast(), visited < 12000, Date() < deadline {
    visited += 1
    guard let role = stringAttribute(item, kAXRoleAttribute as CFString) else { continue }
    if role == "AXPopUpButton" {
        for name in [kAXTitleAttribute as CFString, kAXDescriptionAttribute as CFString] {
            if let value = stringAttribute(item, name), isWeeklyUsageBadge(value) { badges.insert(value) }
        }
    }
    if !leaves.contains(role) { stack.append(contentsOf: elements(item, kAXChildrenAttribute as CFString).reversed()) }
}
if badges.isEmpty { emit(Date() >= deadline || visited >= 12000 ? "incomplete" : "not_found") }
else { emit("ok", Array(badges).sorted()) }
