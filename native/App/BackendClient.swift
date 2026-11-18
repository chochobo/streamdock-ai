import AppKit
import Combine
import Foundation

private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct DeviceState: Decodable {
    var connected: Bool = false
    var model: String?
    var error: String?
    var mode: String?
}

struct Meter: Decodable {
    var value: Double?
    var direction: String?
    var warningAt: Double?
    var criticalAt: Double?
    var stale: Bool?
}

struct MemoryValue: Decodable {
    var usedBytes: Double?
    var totalBytes: Double?
    var estimated: Bool?
}

struct DeckKey: Decodable, Identifiable {
    var index: Int
    var id: String? { "\(index)" }
    var label: String?
    var caption: String?
    var detail: String?
    var state: String?
    var kind: String?
    var action: String?
    var disabled: Bool?
    var provider: String?
    var usedPercent: Double?
    var windowLabel: String?
    var resetDate: String?
    var resetTime: String?
    var usageStatus: String?
    var bar: Meter?
    var memory: MemoryValue?
}

struct PreviewFrame: Decodable {
    var index: Int?
    var slot: Int?
    var url: String

    var image: NSImage? {
        guard let comma = url.firstIndex(of: ","), url.hasPrefix("data:image/") else { return nil }
        let encoded = String(url[url.index(after: comma)...])
        guard encoded.utf8.count <= 2_000_000, let data = Data(base64Encoded: encoded) else { return nil }
        return NSImage(data: data)
    }
}

struct DeckState: Decodable {
    var revision: Int
    var view: String?
    var mode: String?
    var scope: String?
    var title: String?
    var page: Int?
    var pages: Int?
    var keys: [DeckKey]
    var frames: [PreviewFrame]?
    var keyFrames: [PreviewFrame]?
    var sideFrames: [PreviewFrame]?
    var message: String?
}

struct DeckSummary: Decodable {
    var working: Int?
    var blocked: Int?
    var done: Int?
    var unknown: Int?
    var errors: Int?
    var estimated: Bool?
    var attentionProject: String?
    var time: String?
    var warning: Bool?
}

struct AgentState: Decodable, Identifiable {
    var id: String
    var name: String?
    var title: String?
    var project: String?
    var provider: String?
    var presence: String?
    var status: String?
    var confidence: String?
    var isSubagent: Bool?
}

struct UsageWindow: Decodable, Identifiable {
    var id: String?
    var label: String?
    var usedPercent: Double?
    var resetsAt: String?
    var resetLabel: String?
    var status: String?
}

struct UsageAccount: Decodable, Identifiable {
    var id: String?
    var provider: String?
    var label: String?
    var status: String?
    var windows: [UsageWindow]?
}

struct UsageState: Decodable {
    var accounts: [UsageAccount]?
    var warnings: [String]?
    var issues: [UsageIssue]?
}

struct UsageIssue: Decodable {
    var provider: String?
    var code: String?
}

struct SoundSettings: Codable, Equatable {
    var enabled: Bool
}

struct ScreenSettings: Codable, Equatable {
    var enabled: Bool
    var idleMinutes: Int
    var scene: String
}

struct AppSettings: Codable, Equatable {
    var version: Int?
    var language: String
    var sound: SoundSettings
    var brightness: Int?
    var screensaver: ScreenSettings
}

struct DashboardState: Decodable {
    var device: DeviceState
    var agents: [AgentState]?
    var usage: UsageState?
    var settings: AppSettings?
    var summary: DeckSummary?
    var deck: DeckState?
    var cleanup: ReviewEnvelope?
    var worktreeReview: ReviewEnvelope?
    var parcelReview: ReviewEnvelope?
    var parcelImportReview: ReviewEnvelope?
    var remoteReview: ReviewEnvelope?
    var updateReview: ReviewEnvelope?
    var warnings: [String]?
    var updatedAt: String?

    var claudeAccessibilityRequired: Bool {
        usage?.issues?.contains(where: { $0.provider == "claude-desktop" && $0.code == "permission_required" }) == true
    }
}

/// A native client for the local engine. It never starts another HID connection.
@MainActor final class BackendClient: ObservableObject {
    @Published private(set) var state: DashboardState?
    @Published var errorMessage: String?
    @Published private(set) var busy = false
    @Published private(set) var diagnostics: [String: Any] = [:]
    let service: BackendService
    private var pollTask: Task<Void, Never>?
    private var connectionError = false
    private let session: URLSession

    init(service: BackendService) {
        self.service = service
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 8
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.urlCredentialStorage = nil
        session = URLSession(configuration: config, delegate: RejectRedirects(), delegateQueue: nil)
    }

    func start() {
        guard pollTask == nil else { return }
        service.start()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        service.stop()
    }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        guard let token = service.token, !token.isEmpty else { throw ClientError.notReady }
        guard service.baseURL.scheme == "http", service.baseURL.host == "127.0.0.1", let port = service.baseURL.port, (1...65535).contains(port),
              let url = URL(string: path, relativeTo: service.baseURL)?.absoluteURL,
              url.scheme == "http", url.host == "127.0.0.1", url.port == port else { throw ClientError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "X-StreamDock-Native-Token")
        if method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let origin = "\(service.baseURL.scheme ?? "http")://\(service.baseURL.host ?? "127.0.0.1"):\(service.baseURL.port ?? 4174)"
            request.setValue(origin, forHTTPHeaderField: "Origin")
            request.httpBody = try JSONSerialization.data(withJSONObject: body ?? [:])
        }
        return request
    }

    func refresh() async {
        guard service.token != nil else { state = nil; return }
        do {
            let (data, response) = try await session.data(for: request("/api/status"))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ClientError.response }
            state = try JSONDecoder().decode(DashboardState.self, from: data)
            if connectionError { errorMessage = nil; connectionError = false }
        } catch {
            state = nil
            errorMessage = "앱 엔진에 연결할 수 없습니다. 연결 상태를 확인하세요."
            connectionError = true
        }
    }

    func press(_ key: DeckKey) async {
        guard !busy, key.disabled != true, key.action != "none", let revision = state?.deck?.revision else { return }
        errorMessage = nil
        busy = true
        defer { busy = false }
        do {
            let (data, response) = try await session.data(for: request("/api/press", method: "POST", body: ["index": key.index, "revision": revision]))
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 409 {
                await refresh()
                errorMessage = "화면이 바뀌었습니다. 다시 눌러 주세요."
                return
            }
            guard status == 200 else {
                let responseMessage = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
                throw ClientError.server(responseMessage ?? "버튼 동작을 완료하지 못했습니다.")
            }
            await refresh()
        } catch let ClientError.server(message) {
            errorMessage = message
        } catch {
            errorMessage = "버튼 동작을 완료하지 못했습니다."
        }
    }

    func saveSettings(_ body: [String: Any]) async throws {
        let (data, response) = try await session.data(for: request("/api/native/settings", method: "POST", body: body))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw ClientError.server(message ?? "설정을 저장하지 못했습니다.")
        }
        await refresh()
    }

    func refreshStatus() async {
        guard !busy else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let (_, response) = try await session.data(for: request("/api/refresh", method: "POST"))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ClientError.response }
            await refresh()
        } catch {
            errorMessage = "상태를 갱신하지 못했습니다."
        }
    }

    func refreshUsage() async {
        do {
            let (_, response) = try await session.data(for: request("/api/usage/refresh", method: "POST"))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ClientError.response }
            await refresh()
        } catch { errorMessage = "사용량을 갱신하지 못했습니다." }
    }

    func loadDiagnostics() async {
        do {
            let (data, response) = try await session.data(for: request("/api/native/diagnostics"))
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            diagnostics = value
        } catch { diagnostics = [:] }
    }

    func loadProvider(_ kind: String) async throws -> [String: Any] {
        guard ["market", "parcels", "remote", "credits"].contains(kind) else { throw ClientError.response }
        let (data, response) = try await session.data(for: request("/api/native/providers/\(kind)"))
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ClientError.response }
        return value
    }

    func saveProvider(_ kind: String, revision: String, patch: [String: Any]) async throws -> [String: Any] {
        guard ["market", "parcels", "remote", "credits"].contains(kind) else { throw ClientError.response }
        let (data, response) = try await session.data(for: request("/api/native/providers/\(kind)", method: "POST", body: ["revision": revision, "patch": patch]))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let responseObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        if status == 409 {
            switch responseObject?["code"] as? String {
            case "busy": throw ClientError.server("다른 작업이 진행 중입니다. 잠시 뒤 다시 시도하세요.")
            case "identity_changed": throw ClientError.server("이 항목의 식별자를 직접 변경할 수 없습니다. 기존 항목을 삭제하고 새 항목을 추가하세요.")
            case "rows_changed": throw ClientError.server("항목 목록이 변경됐습니다. 다시 불러와 삭제 대상을 확인하세요.")
            default: throw ClientError.server("설정이 다른 곳에서 변경됐습니다. 다시 불러온 뒤 수정하세요.")
            }
        }
        guard status == 200, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            let message = responseObject?["message"] as? String
            throw ClientError.server(message ?? "설정을 저장하지 못했습니다.")
        }
        return value
    }
}

enum ClientError: LocalizedError {
    case notReady, invalidURL, response
    case server(String)
    var errorDescription: String? {
        switch self {
        case .server(let text): return text
        case .notReady: return "앱 엔진이 준비되지 않았습니다."
        default: return "요청을 완료하지 못했습니다."
        }
    }
}
