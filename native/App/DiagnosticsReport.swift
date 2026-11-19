import Foundation

/// Diagnostics text shared by the diagnostics screen and the "copy" button.
/// Pure: it reads only the given state and time. The report deliberately leaves out
/// agents, sessions, projects, usage accounts and raw warning text, and redacts
/// emails, paths and token-like runs from the free-text fields it does include.
enum DiagnosticsReport {
    static func text(from state: DashboardState?, now: Date, appVersion: String? = nil) -> String {
        var lines = ["StreamDock AI 진단 정보", "생성 시각: \(isoString(now))"]
        lines.append("앱 버전: \(appVersion.map(redact) ?? "미확인")")
        guard let state else {
            lines.append("앱 엔진: 상태를 받지 못함")
            return lines.joined(separator: "\n")
        }
        let device = state.device
        lines.append("기기: \(device.connected ? "연결됨" : "연결 안 됨") · 모드 \(device.mode.map(redact) ?? "미확인")")
        lines.append("모델: \(device.model.map(redact) ?? "미확인")")
        lines.append("배열: \(layoutLabel(state.deck?.layout) ?? "미확인")")
        lines.append("마지막 기기 응답: \(timeLabel(device.lastDeviceAcknowledgementAt, now: now))")
        lines.append("마지막 하트비트: \(timeLabel(device.lastTransportHeartbeatAt, now: now))")
        if let error = device.error, !error.isEmpty { lines.append("기기 오류: \(redact(error))") }
        lines.append("재연결: \(reconnectLabel(state.connection, connected: device.connected, now: now) ?? "정보 없음")")
        if let lastError = state.connection?.lastError, !lastError.isEmpty { lines.append("마지막 재연결 오류: \(redact(lastError))") }
        lines.append("마지막 입력: \(inputLabel(state.lastInput, now: now) ?? "없음")")
        let warnings = state.warnings ?? []
        lines.append("알림: \(warnings.count)건\(warnings.isEmpty ? "" : " (\(warningKinds(warnings, codes: state.warningCodes).joined(separator: ", ")))")")
        if let settingsError = state.settingsError {
            let field = settingsError.field.map { " · 항목 \(redact($0))" } ?? ""
            lines.append("설정 오류: \(settingsError.code.map(redact) ?? "unknown")\(field)")
        }
        return lines.joined(separator: "\n")
    }

    /// "3초 전" for past times, "5초 후" for future ones.
    static func relative(_ iso: String?, now: Date) -> String? {
        guard let date = parse(iso) else { return nil }
        let seconds = Int(now.timeIntervalSince(date).rounded())
        let magnitude = abs(seconds)
        if magnitude < 1 { return "방금" }
        let amount: String
        if magnitude < 60 { amount = "\(magnitude)초" }
        else if magnitude < 3600 { amount = "\(magnitude / 60)분" }
        else if magnitude < 86400 { amount = "\(magnitude / 3600)시간" }
        else { amount = "\(magnitude / 86400)일" }
        return seconds > 0 ? "\(amount) 전" : "\(amount) 후"
    }

    static func reconnectLabel(_ connection: ConnectionState?, connected: Bool, now: Date) -> String? {
        guard let connection else { return nil }
        let failures = connection.consecutiveFailures ?? 0
        if connected && connection.reconnecting != true { return failures > 0 ? "연결됨 · 연속 실패 \(failures)회" : "연결됨" }
        var parts = [connection.reconnecting == true ? "재연결 시도 중" : "재연결 중"]
        if connection.reconnecting != true, let next = relative(connection.nextAttemptAt, now: now) {
            parts.append(next.hasSuffix("후") ? "다음 시도 \(next)" : "곧 다음 시도")
        }
        if failures > 0 { parts.append("연속 실패 \(failures)회") }
        return parts.joined(separator: " · ")
    }

    static func inputLabel(_ input: LastInputState?, now: Date) -> String? {
        guard let input else { return nil }
        var parts: [String] = []
        if let index = input.index { parts.append("키 \(index)") }
        else if let control = input.control { parts.append("로커 \(redact(control))\(input.action.map { " \(redact($0))" } ?? "")") }
        else { parts.append("입력") }
        if let code = input.code { parts.append(redact(code)) }
        if let when = relative(input.at, now: now) { parts.append(when) }
        return parts.joined(separator: " · ")
    }

    static func layoutLabel(_ layout: DeckLayout?) -> String? {
        guard let layout, layout.cols > 0, layout.rows > 0 else { return nil }
        return "\(redact(layout.name)) (\(redact(layout.model)), \(layout.cols)x\(layout.rows))"
    }

    /// Coarse categories only: warning text can name accounts or projects.
    /// Diagnostics category per warning code; mirrors `category` in src/warnings.mjs.
    static let warningCategories: [String: String] = [
        "settings_unreadable": "settings", "refresh_failed": "status", "action_failed": "other",
        "codex_history_unreadable": "other", "agent_history_unreadable": "other", "sessions_unknown": "other",
        "claude_sessions_partial": "other", "codex_sessions_partial": "other",
        "codex_usage_stale": "usage", "codex_usage_unavailable": "usage", "claude_usage_unavailable": "usage",
        "claude_desktop_usage_stale": "other", "claude_desktop_permission_required": "usage",
        "claude_desktop_usage_ambiguous": "usage", "claude_desktop_usage_not_found": "usage",
        "claude_desktop_usage_unreadable": "usage", "credits_unreadable": "credits",
        "credits_source_unsupported": "other", "credits_browser_setup_required": "settings",
    ]

    /// Classify by code when the backend sends one; otherwise fall back to the message text.
    static func warningKinds(_ warnings: [String], codes: [String]? = nil) -> [String] {
        let usable = codes?.count == warnings.count ? codes : nil
        let kinds = warnings.enumerated().map { index, warning -> String in
            if let code = usable?[index], let category = warningCategories[code] { return category }
            if warning.contains("설정") { return "settings" }
            if warning.contains("크레딧") { return "credits" }
            if warning.contains("사용량") { return "usage" }
            if warning.contains("상태") { return "status" }
            return "other"
        }
        return kinds.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
    }

    static func redact(_ value: String) -> String {
        var text = value
        let rules: [(String, String)] = [
            (#"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"#, "<email>"),
            (#"(^|[\s'"`(=:])~?/[^\s'"`)]+"#, "$1<path>"),
            (#"[A-Za-z0-9_\-]{24,}"#, "<redacted>"),
        ]
        for (pattern, template) in rules {
            text = text.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return String(text.prefix(200))
    }

    private static func timeLabel(_ iso: String?, now: Date) -> String {
        guard let date = parse(iso), let relative = relative(iso, now: now) else { return "기록 없음" }
        return "\(relative) (\(isoString(date)))"
    }

    private static func parse(_ iso: String?) -> Date? {
        guard let iso, !iso.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    private static func isoString(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
}
