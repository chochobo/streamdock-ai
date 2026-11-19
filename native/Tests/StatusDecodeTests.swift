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

        let xl = try decoder.decode(DashboardState.self, from: load("status-xl.json"))
        let xlLayout = xl.deck?.deckLayout
        try check(xl.device.model == "Stream Dock XL (5548:1028)" && xl.deviceName == "Stream Dock XL", "XL device name")
        try check(xlLayout?.model == "xl" && xlLayout?.cols == 8 && xlLayout?.rows == 4 && xlLayout?.keyCount == 32, "XL grid")
        try check(xlLayout?.sideSlots.isEmpty == true && xlLayout?.summaryKeys == [7, 15, 23], "XL summary keys")
        try check(xlLayout?.controls?.modes == 28 && xlLayout?.controls?.next == 31, "XL controls")
        try check(xl.deck?.keys.count == 32 && xl.deck?.sideFrames?.isEmpty == true, "XL keys and no side frames")
        try check(xl.deck?.keyFrames?.map(\.index) == [7, 15, 23] && xl.deck?.keyFrames?.allSatisfy({ $0.image != nil }) == true, "XL summary frames")

        let legacyDeck = try decoder.decode(DashboardState.self, from: load("status-no-layout.json"))
        try check(legacyDeck.deck?.layout == nil && legacyDeck.deck?.deckLayout == .s293, "missing layout falls back to 293S")
        try check(legacyDeck.deck?.deckLayout.cols == 5 && legacyDeck.deck?.deckLayout.rows == 3 && legacyDeck.deck?.deckLayout.sideSlots == [16, 17, 18], "293S fallback geometry")
        try check(legacyDeck.deviceName == "Stream Dock 293S V3" && legacyDeck.deck?.keys.count == 15, "293S fallback name and keys")
        try check(complete.deck?.deckLayout == .s293 && partial.deck?.deckLayout == .s293, "existing fixtures decode as 293S")
        let badLayout = Data(#"{"device":{"connected":true},"deck":{"revision":1,"keys":[],"layout":{"model":"x","name":"X","cols":0,"rows":0,"keyCount":0,"sideSlots":[],"summaryKeys":[]}}}"#.utf8)
        let badState = try decoder.decode(DashboardState.self, from: badLayout)
        try check(badState.deck?.deckLayout == .s293, "unusable layout falls back to 293S")
        let partialLayout = Data(#"{"device":{"connected":true,"model":"Stream Dock XL (5548:1028)"},"deck":{"revision":2,"keys":[{"index":0}],"layout":{"model":"xl","name":"Stream Dock XL","cols":8,"rows":"4"}}}"#.utf8)
        let partialLayoutState = try decoder.decode(DashboardState.self, from: partialLayout)
        try check(partialLayoutState.deck?.keys.count == 1 && partialLayoutState.device.connected, "partial layout keeps the rest of the status")
        try check(partialLayoutState.deck?.deckLayout == .s293, "partial layout falls back to 293S")

        try check(DiagnosticsReport.warningKinds(["문구가 바뀐 경고"], codes: ["credits_unreadable"]) == ["credits"], "warning code wins over text")
        try check(DiagnosticsReport.warningKinds(["설정을 읽지 못했습니다."], codes: nil) == ["settings"], "text fallback without codes")
        try check(DiagnosticsReport.warningKinds(["a", "b"], codes: ["credits_unreadable"]) == ["other"], "mismatched code count falls back to text")
        let coded = try decoder.decode(DashboardState.self, from: Data(#"{"device":{"connected":true},"warnings":["x"],"warningCodes":["refresh_failed"]}"#.utf8))
        try check(coded.warningCodes == ["refresh_failed"], "warning codes decode")
        let stringLayout = try decoder.decode(DashboardState.self, from: Data(#"{"device":{"connected":true},"deck":{"revision":3,"keys":[{"index":0}],"layout":"xl"}}"#.utf8))
        try check(stringLayout.deck?.keys.count == 1 && stringLayout.deck?.deckLayout == .s293, "non-object layout keeps the status and falls back to 293S")
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

        try check(complete.settingsError == nil && partial.settingsError == nil && xl.settingsError == nil, "absent settings error")
        let settingsError = try decoder.decode(DashboardState.self, from: load("status-settings-error.json"))
        try check(settingsError.settingsError?.code == "settings_invalid_value" && settingsError.settingsError?.field == "brightness", "settings error code and field")
        try check(settingsError.settingsError?.message == "brightness 값은 null 또는 0에서 100 사이의 정수여야 합니다.", "settings error message")
        try check(settingsError.warnings == ["설정을 읽지 못했습니다."], "settings warning kept")
        let unreadable = try decoder.decode(DashboardState.self, from: Data(#"{"device":{"connected":false},"settingsError":{"code":"settings_unreadable","field":null,"allowed":null,"message":"설정을 읽지 못했습니다."}}"#.utf8))
        try check(unreadable.settingsError?.field == nil && unreadable.settingsError?.code == "settings_unreadable", "settings error without field")
        let nullError = try decoder.decode(DashboardState.self, from: Data(#"{"device":{"connected":true},"settingsError":null}"#.utf8))
        try check(nullError.settingsError == nil, "null settings error")

        // Diagnostics: reconnect state, timestamps, last input, and the copyable report.
        try check(complete.connection == nil && complete.lastInput == nil && complete.device.lastTransportHeartbeatAt == nil, "older status has no diagnostics fields")
        let diag = try decoder.decode(DashboardState.self, from: load("status-diagnostics.json"))
        try check(diag.connection?.reconnecting == false && diag.connection?.consecutiveFailures == 3, "connection fields")
        try check(diag.connection?.nextAttemptAt == "2026-11-19T10:00:15.000Z" && diag.connection?.lastError == "장치를 열지 못했습니다.", "connection time and error")
        try check(diag.device.lastDeviceAcknowledgementAt == "2026-11-19T10:00:07.000Z" && diag.device.lastTransportHeartbeatAt == "2026-11-19T10:00:09.500Z", "device timestamps")
        try check(diag.lastInput?.index == 7 && diag.lastInput?.code == "ok", "last key input")
        let rocker = try decoder.decode(DashboardState.self, from: Data(#"{"device":{"connected":true},"lastInput":{"control":"rocker","action":"left","code":"ok"},"connection":{"reconnecting":"yes","consecutiveFailures":"2","nextAttemptAt":null}}"#.utf8))
        try check(rocker.lastInput?.control == "rocker" && rocker.lastInput?.index == nil, "rocker input")
        try check(rocker.connection != nil && rocker.connection?.reconnecting == nil && rocker.connection?.consecutiveFailures == nil, "malformed connection fields decode as nil")
        let wrongShape = try decoder.decode(DashboardState.self, from: Data(#"{"device":{"connected":true},"connection":"down","lastInput":3}"#.utf8))
        try check(wrongShape.device.connected && wrongShape.connection?.consecutiveFailures == nil && wrongShape.lastInput?.index == nil, "non-object diagnostics keep the status")

        let now = ISO8601DateFormatter().date(from: "2026-11-19T10:00:10Z")!
        try check(DiagnosticsReport.relative("2026-11-19T10:00:07.000Z", now: now) == "3초 전", "relative past")
        try check(DiagnosticsReport.relative("2026-11-19T10:00:15.000Z", now: now) == "5초 후", "relative future")
        try check(DiagnosticsReport.relative("2026-11-19T09:58:10Z", now: now) == "2분 전" && DiagnosticsReport.relative(nil, now: now) == nil, "relative minutes and missing")
        try check(DiagnosticsReport.reconnectLabel(diag.connection, connected: false, now: now) == "재연결 중 · 다음 시도 5초 후 · 연속 실패 3회", "reconnect label")
        try check(DiagnosticsReport.inputLabel(rocker.lastInput, now: now) == "로커 rocker left · ok", "rocker label")
        let report = DiagnosticsReport.text(from: diag, now: now, appVersion: "0.1.0")
        for expected in ["앱 버전: 0.1.0", "Stream Dock XL (5548:1028)", "Stream Dock XL (xl, 8x4)", "마지막 기기 응답: 3초 전", "마지막 하트비트:",
                         "재연결 중 · 다음 시도 5초 후 · 연속 실패 3회", "마지막 재연결 오류: 장치를 열지 못했습니다.", "마지막 입력: 키 7 · ok · 5초 전",
                         "알림: 3건 (settings, status, usage)", "설정 오류: settings_invalid_value · 항목 brightness", "기기 오류: open failed: <path>"] {
            try check(report.contains(expected), "report contains \(expected)\n\(report)")
        }
        for forbidden in ["SECRET-SESSION-TITLE-ZETA", "secret-project-omega", "alice@example.com", "alice", "/Users/", "fixtureToken", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", ".jsonl", "fixture-secret-agent"] {
            try check(!report.contains(forbidden), "report must not contain \(forbidden)\n\(report)")
        }
        let emptyReport = DiagnosticsReport.text(from: nil, now: now)
        try check(emptyReport.contains("앱 버전: 미확인") && emptyReport.contains("상태를 받지 못함"), "report without status")

        let invalid = Data(#"{"device":{"connected":true},"summary":{"warning":"false"}}"#.utf8)
        do {
            _ = try decoder.decode(DashboardState.self, from: invalid)
            throw TestFailure.failed("warning must be a boolean")
        } catch is DecodingError { /* Incorrect backend types fail explicitly. */ }

        // Preview fallback text follows the settings language; missing or unknown means Korean.
        try check(complete.settings?.language == "ko", "fixture language")
        let noSettings = try decoder.decode(DashboardState.self, from: Data(#"{"device":{"connected":true}}"#.utf8))
        try check(noSettings.settings?.language == nil, "missing language")
        func side(_ slot: Int, _ language: String?, summary: Bool = true, warning: Bool? = nil, project: String? = nil) -> String {
            PreviewText.side(slot: slot, working: 2, blocked: 1, done: 3, warning: warning, attentionProject: project,
                             time: "09:05", hasSummary: summary, language: language)
        }
        for language in [nil, "ko", "xx"] as [String?] {
            try check(side(16, language) == "작업 2\n확인 1\n완료 3", "ko slot 16")
            try check(side(17, language) == "알림 없음" && side(17, language, warning: true) == "알림 확인", "ko slot 17")
            try check(side(17, language, project: "demo") == "demo", "attention project")
            try check(side(18, language) == "갱신\n09:05", "ko slot 18")
            try check(side(16, language, summary: false) == "확인 중", "ko loading")
            try check(PreviewText.summaryKeyPlaceholder(language: language) == "요약", "ko summary key")
        }
        try check(side(16, "en") == "WORK 2\nASK 1\nDONE 3", "en slot 16")
        try check(side(17, "en") == "ALERT NONE" && side(17, "en", warning: true) == "STATUS CHECK", "en slot 17")
        try check(side(17, "en", project: "demo") == "demo", "en attention project")
        try check(side(18, "en") == "UPDATED\n09:05", "en slot 18")
        try check(side(16, "en", summary: false) == "CHECKING", "en loading")
        try check(PreviewText.summaryKeyPlaceholder(language: "en") == "SUMMARY", "en summary key")
        print("Native status decoding fixtures passed")
    }
}
