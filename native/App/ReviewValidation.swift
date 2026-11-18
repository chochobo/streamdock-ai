import CryptoKit
import Foundation

// Validate the complete, private review response against its public plan before
// showing or acknowledging it. The server still revalidates before execution.
enum ReviewValidation {
    static func current(stage: String?, id: String?, revision: Int?, plan: ReviewValue?,
                        openedID: String?, openedRevision: Int?, openedPlan: ReviewValue?, visible: Bool = true) -> Bool {
        guard visible, let openedID, let openedRevision, let openedPlan else { return false }
        return stage == "review" && id == openedID && revision == openedRevision && plan == openedPlan
    }

    private static func string(_ object: [String: ReviewValue], _ key: String) -> String? {
        object[key]?.string
    }

    private static func number(_ object: [String: ReviewValue], _ key: String, range: ClosedRange<Int>) -> Int? {
        guard case .number(let value) = object[key], value.isFinite,
              value.rounded() == value, value >= Double(range.lowerBound), value <= Double(range.upperBound) else { return nil }
        return Int(value)
    }

    private static func nonempty(_ value: String?, max: Int = 300) -> Bool {
        guard let value, value.utf16.count <= max, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) else { return false }
        return match.range == NSRange(value.startIndex..., in: value)
    }

    private static func safeFields(_ value: ReviewValue) -> Bool {
        switch value {
        case .object(let object):
            return object.allSatisfy { key, value in
                !["token", "authorization", "password", "cookie"].contains(key.lowercased()) && safeFields(value)
            }
        case .array(let values): return values.allSatisfy(safeFields)
        default: return true
        }
    }

    static func valid(kind: String, id: String, plan: ReviewValue?, detail: ReviewValue) -> Bool {
        guard matches(id, "^[a-f0-9]{48}$"), let publicPlan = plan?.object,
              let payload = detail.object, string(payload, "reviewId") == id, safeFields(detail) else { return false }
        switch kind {
        case "parcel":
            guard string(publicPlan, "destination") == "Cainiao", string(payload, "destination") == "Cainiao",
                  let scope = string(publicPlan, "scope"), nonempty(scope), string(payload, "scope") == scope,
                  let count = number(publicPlan, "count", range: 1...50), number(payload, "count", range: 1...50) == count,
                  let targets = payload["targets"]?.array, targets.count == count else { return false }
            var tracking = Set<String>()
            for item in targets {
                guard let target = item.object, nonempty(string(target, "title")), let code = string(target, "tracking"),
                      matches(code, "^[A-Z0-9-]{5,60}$"), tracking.insert(code).inserted else { return false }
            }
            return true
        case "remote":
            guard let label = string(publicPlan, "label"), nonempty(label), string(payload, "label") == label,
                  let operation = string(publicPlan, "operation"), ["machine", "agents", "agy"].contains(operation), string(payload, "operation") == operation,
                  let scope = string(publicPlan, "scope"), nonempty(scope), string(payload, "scope") == scope,
                  let host = string(payload, "host"), host.utf16.count <= 317, !host.contains(".."),
                  matches(host, "^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$"),
                  number(payload, "port", range: 1...65535) != nil else { return false }
            return true
        case "parcelImport":
            guard let source = string(publicPlan, "source"), nonempty(source), string(payload, "source") == source,
                  let count = number(publicPlan, "count", range: 1...40), number(payload, "count", range: 1...40) == count,
                  let entries = payload["entries"]?.array, entries.count == count else { return false }
            var ids = Set<String>(), tracking = Set<String>()
            for value in entries {
                guard let entry = value.object, let entryID = string(entry, "id"), matches(entryID, "^[a-f0-9]{20}$"), ids.insert(entryID).inserted,
                      nonempty(string(entry, "title")), let code = string(entry, "tracking"), matches(code, "^[A-Z0-9-]{8,30}$"),
                      tracking.insert(code).inserted, entry["exists"]?.bool != nil else { return false }
            }
            return true
        case "update":
            guard string(publicPlan, "action") == "fast-forward", string(payload, "action") == "fast-forward",
                  let current = string(publicPlan, "current"), matches(current, "^[a-fA-F0-9]{40,64}$"), string(payload, "current") == current,
                  let target = string(publicPlan, "target"), matches(target, "^[a-fA-F0-9]{40,64}$"), string(payload, "target") == target,
                  let count = number(publicPlan, "count", range: 1...300), let values = payload["files"]?.array, values.count == count,
                  let root = string(payload, "root"), root.hasPrefix("/"), nonempty(root, max: 4096),
                  nonempty(string(payload, "branch"), max: 200), let urlText = string(payload, "remoteUrl"), let url = URLComponents(string: urlText),
                  url.scheme == "https", url.host?.isEmpty == false, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
                  !url.path.isEmpty, url.path != "/", let diff = string(payload, "diff"), !diff.isEmpty, diff.utf8.count <= 2 * 1024 * 1024,
                  let expectedHash = string(payload, "diffHash"), matches(expectedHash, "^[a-fA-F0-9]{64}$") else { return false }
            var paths = Set<String>()
            for value in values {
                guard let path = value.string, !path.isEmpty, !path.contains("\0"), paths.insert(path).inserted else { return false }
            }
            return SHA256.hash(data: Data(diff.utf8)).map { String(format: "%02x", $0) }.joined() == expectedHash.lowercased()
        default: return false
        }
    }
}
