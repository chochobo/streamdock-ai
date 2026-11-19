import Foundation

/// Fallback text for preview slots that have no device image yet. English words match the device summary in src/summary.mjs.
enum PreviewText {
    static func isEnglish(_ language: String?) -> Bool { language == "en" }

    static func summaryKeyPlaceholder(language: String?) -> String {
        isEnglish(language) ? "SUMMARY" : "요약"
    }

    static func side(slot: Int, summary: DeckSummary?, language: String?) -> String {
        side(slot: slot, working: summary?.working, blocked: summary?.blocked, done: summary?.done,
             warning: summary?.warning, attentionProject: summary?.attentionProject, time: summary?.time,
             hasSummary: summary != nil, language: language)
    }

    static func side(slot: Int, working: Int?, blocked: Int?, done: Int?, warning: Bool?, attentionProject: String?,
                     time: String?, hasSummary: Bool, language: String?) -> String {
        let en = isEnglish(language)
        guard hasSummary else { return en ? "CHECKING" : "확인 중" }
        switch slot {
        case 16: return "\(en ? "WORK" : "작업") \(working ?? 0)\n\(en ? "ASK" : "확인") \(blocked ?? 0)\n\(en ? "DONE" : "완료") \(done ?? 0)"
        case 17:
            if warning == true { return en ? "STATUS CHECK" : "알림 확인" }
            return attentionProject ?? (en ? "ALERT NONE" : "알림 없음")
        default: return "\(en ? "UPDATED" : "갱신")\n\(time ?? "--:--")"
        }
    }
}
