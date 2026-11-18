import AppKit
import Foundation

private enum TestFailure: Error { case failed(String) }
private func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw TestFailure.failed(message) }
}

@main struct StatusDecodeTests {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { throw TestFailure.failed("fixture directory required") }
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        func load(_ file: String) throws -> Data { try Data(contentsOf: directory.appendingPathComponent(file)) }
        let decoder = JSONDecoder()
        let complete = try decoder.decode(DashboardState.self, from: load("status-complete.json"))
        try check(complete.device.connected, "device connection")
        try check(complete.summary?.warning == false && complete.summary?.estimated == true, "boolean warning and estimated")
        try check(complete.agents?.count == 2 && complete.agents?.first?.id == "fixture-codex-1", "agent identities")
        try check(complete.agents?.last?.name == nil && complete.agents?.last?.isSubagent == true, "nullable agent fields")
        try check(complete.usage?.accounts?.first?.windows?.first?.usedPercent == 25.5, "fractional usage")
        try check(complete.usage?.accounts?.last?.windows?.first?.usedPercent == nil, "null usage")
        try check(complete.usage?.accounts?.last?.windows?.first?.resetLabel == "금 03:00", "weekday-only reset")
        try check(complete.settings?.screensaver.scene == "aquarium" && complete.settings?.brightness == nil, "settings")
        let deck = complete.deck
        try check(deck?.revision == 42 && deck?.keys.count == 2, "deck revision and keys")
        try check(deck?.keys.first?.memory?.usedBytes == 8589934592 && deck?.keys.first?.bar?.value == 25, "memory and meter")
        try check(deck?.frames?.first?.index == 0 && deck?.keyFrames?.first?.index == 1 && deck?.sideFrames?.first?.slot == 16, "frame positions")
        try check(deck?.frames?.first?.image != nil && deck?.sideFrames?.first?.image != nil, "PNG frames")
        try check(complete.cleanup?.plan?.object?["executable"]?.bool == false, "cleanup plan")
        try check(complete.cleanup?.plan?.object?["targets"]?.array?.count == 1, "complete cleanup targets")
        try check(complete.worktreeReview?.plan?.object?["eligible"]?.bool == false, "worktree review")
        try check(complete.parcelReview?.plan?.object?["destination"]?.string == "Cainiao", "parcel review")
        try check(complete.parcelImportReview?.stage == "review", "parcel import review")
        try check(complete.remoteReview?.reviewed == true, "remote review")
        try check(complete.updateReview?.stage == "unavailable" && complete.updateReview?.plan == nil, "unavailable update")

        let partial = try decoder.decode(DashboardState.self, from: load("status-partial.json"))
        try check(!partial.device.connected && partial.device.model == nil, "partial device")
        try check(partial.summary?.warning == true && partial.summary?.working == nil, "true warning and missing fields")
        try check(partial.agents?.first?.id == "fixture-unknown" && partial.agents?.first?.provider == nil, "partial agent")
        try check(partial.usage?.accounts?.first?.windows == nil, "nullable usage windows")
        try check(partial.settings == nil && partial.updatedAt == nil, "null and missing optionals")
        try check(partial.deck?.keys.first?.label == nil && partial.deck?.keyFrames == nil, "partial key and frames")
        try check(partial.cleanup == nil && partial.worktreeReview == nil && partial.parcelImportReview == nil, "null and absent reviews")
        try check(partial.parcelReview?.stage == "loading" && partial.parcelReview?.reviewId == nil, "loading review")
        try check(partial.remoteReview?.message == "확인할 수 없습니다.", "review message")

        let structuredPermission = Data(#"{"device":{"connected":false},"usage":{"issues":[{"provider":"claude-desktop","code":"permission_required"}]}}"#.utf8)
        let structuredState = try decoder.decode(DashboardState.self, from: structuredPermission)
        try check(structuredState.claudeAccessibilityRequired, "structured accessibility warning")
        let unrelatedIssues = Data(#"{"device":{"connected":false},"usage":{"issues":[{"provider":"codex","code":"permission_required"},{"provider":"claude-desktop","code":"unavailable"}]}}"#.utf8)
        let unrelatedState = try decoder.decode(DashboardState.self, from: unrelatedIssues)
        try check(!unrelatedState.claudeAccessibilityRequired, "unrelated structured issues")
        let legacyPermission = Data(#"{"device":{"connected":false},"usage":{"warnings":["Claude Desktop 접근성 권한이 없어 사용량을 읽지 못했습니다."]}}"#.utf8)
        let legacyState = try decoder.decode(DashboardState.self, from: legacyPermission)
        try check(!legacyState.claudeAccessibilityRequired, "text warnings alone do not assert the required permission")
        let otherWarning = Data(#"{"device":{"connected":false},"usage":{"warnings":["Claude Desktop을 찾지 못했습니다."]}}"#.utf8)
        let otherState = try decoder.decode(DashboardState.self, from: otherWarning)
        try check(!otherState.claudeAccessibilityRequired, "unrelated warning")

        let invalid = Data(#"{"device":{"connected":true},"summary":{"warning":"false"}}"#.utf8)
        do {
            _ = try decoder.decode(DashboardState.self, from: invalid)
            throw TestFailure.failed("warning must be a boolean")
        } catch is DecodingError { /* Incorrect backend types fail explicitly. */ }
        print("Native status decoding fixtures passed")
    }
}
