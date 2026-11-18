import SwiftUI
import Foundation

// The engine removes its private, one-use confirmation token before sending
// review metadata. Keep the complete plan only in memory while it is reviewed.
indirect enum ReviewValue: Decodable, Equatable {
    case object([String: ReviewValue])
    case array([ReviewValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([ReviewValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: ReviewValue].self)) }
    }

    var object: [String: ReviewValue]? { if case .object(let v) = self { return v }; return nil }
    var array: [ReviewValue]? { if case .array(let v) = self { return v }; return nil }
    var string: String? { if case .string(let v) = self { return v }; return nil }
    var bool: Bool? { if case .bool(let v) = self { return v }; return nil }
    var display: String {
        switch self {
        case .string(let v): return v
        case .number(let v): return v.rounded() == v ? String(format: "%.0f", v) : String(v)
        case .bool(let v): return v ? "예" : "아니요"
        case .null: return "미확인"
        default: return ""
        }
    }
}

struct ReviewEnvelope: Decodable {
    var stage: String?
    var reviewId: String?
    var reviewed: Bool?
    var message: String?
    var plan: ReviewValue?
    var expiresAt: String?
}

private enum ReviewKind: String, CaseIterable, Identifiable {
    case parcel, remote, update, cleanup, worktree, parcelImport
    var id: String { rawValue }
    var title: String {
        switch self {
        case .parcel: return "배송 조회"
        case .remote: return "원격 연결"
        case .update: return "업데이트"
        case .cleanup: return "정리 계획"
        case .worktree: return "워크트리 정리"
        case .parcelImport: return "배송 항목 가져오기"
        }
    }
    var detailPath: String? {
        switch self {
        case .parcel: return "/api/parcel-review"
        case .remote: return "/api/remote-review"
        case .update: return "/api/update-review"
        case .parcelImport: return "/api/parcel-import-review"
        default: return nil
        }
    }
    var requiresPhysicalConfirmation: Bool { [.parcel, .remote, .update].contains(self) }
    func review(in state: DashboardState?) -> ReviewEnvelope? {
        switch self {
        case .parcel: return state?.parcelReview
        case .remote: return state?.remoteReview
        case .update: return state?.updateReview
        case .cleanup: return state?.cleanup
        case .worktree: return state?.worktreeReview
        case .parcelImport: return state?.parcelImportReview
        }
    }
}

private enum ReviewRequestError: LocalizedError {
    case unavailable, stale, response
    var errorDescription: String? {
        switch self {
        case .unavailable: return "검토 내용을 불러올 수 없습니다."
        case .stale: return "기기 화면이나 검토 대상이 바뀌었습니다. 다시 확인해 주세요."
        case .response: return "요청을 완료하지 못했습니다."
        }
    }
}

private final class ReviewRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor private struct ReviewTransport {
    let service: BackendService
    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpShouldSetCookies = false
        let session = URLSession(configuration: config, delegate: ReviewRedirectGuard(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        return try await session.data(for: request)
    }
    private func request(path: String, method: String = "GET", body: [String: Any]? = nil,
                         reviewHeader: Bool = false) throws -> URLRequest {
        guard let token = service.token, token.count == 64,
              service.baseURL.scheme == "http", service.baseURL.host == "127.0.0.1",
              let port = service.baseURL.port, (1...65535).contains(port),
              let url = URL(string: path, relativeTo: service.baseURL)?.absoluteURL,
              url.scheme == "http", url.host == "127.0.0.1", url.port == port else { throw ReviewRequestError.unavailable }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "X-StreamDock-Native-Token")
        if reviewHeader { request.setValue("1", forHTTPHeaderField: "X-StreamDock-Review") }
        if method == "POST" {
            request.setValue("http://127.0.0.1:\(port)", forHTTPHeaderField: "Origin")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body ?? [:])
        }
        return request
    }
    private func validID(_ id: String) -> Bool {
        id.utf8.count == 48 && id.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    func detail(kind: ReviewKind, id: String) async throws -> ReviewValue {
        guard validID(id), let path = kind.detailPath else { throw ReviewRequestError.unavailable }
        let (data, response) = try await perform(request(path: "\(path)?reviewId=\(id)", reviewHeader: true))
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 6_000_000 else { throw ReviewRequestError.unavailable }
        return try JSONDecoder().decode(ReviewValue.self, from: data)
    }
    func acknowledge(kind: ReviewKind, id: String, revision: Int) async throws {
        guard validID(id), kind.requiresPhysicalConfirmation else { throw ReviewRequestError.unavailable }
        let (_, response) = try await perform(request(path: "/api/review", method: "POST", body: ["kind": kind.rawValue, "reviewId": id, "revision": revision]))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 409 { throw ReviewRequestError.stale }
        guard status == 200 else { throw ReviewRequestError.response }
    }
    func applyImport(id: String, revision: Int, selected: [String]) async throws {
        guard validID(id), !selected.isEmpty, selected.count <= 50,
              selected.allSatisfy({ $0.utf8.count == 20 && $0.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }) else { throw ReviewRequestError.unavailable }
        let (_, response) = try await perform(request(path: "/api/parcel-import/apply", method: "POST", body: ["reviewId": id, "revision": revision, "selectedIds": selected]))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 409 { throw ReviewRequestError.stale }
        guard status == 200 else { throw ReviewRequestError.response }
    }
}

struct ReviewPanel: View {
    @ObservedObject var client: BackendClient

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("요청 검토").font(.largeTitle.bold())
                Text("기기 화면에서 준비한 요청의 전체 내용을 확인하세요.")
                    .foregroundStyle(.secondary)
                let available = ReviewKind.allCases.filter { $0.review(in: client.state) != nil }
                if available.isEmpty {
                    ContentUnavailableView("검토할 요청이 없습니다", systemImage: "checkmark.shield",
                                           description: Text("기기 화면에서 검토할 요청을 먼저 선택하세요."))
                        .frame(maxWidth: .infinity, minHeight: 220)
                } else {
                    ForEach(available) { kind in
                        if let review = kind.review(in: client.state) {
                            ReviewCard(client: client, kind: kind, review: review)
                                .id("\(kind.rawValue):\(review.reviewId ?? review.stage ?? "")")
                        }
                    }
                }
            }.padding(24)
        }
    }
}

private struct ReviewEndKey: PreferenceKey {
    static var defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
private struct ReviewHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct ReviewCard: View {
    @ObservedObject var client: BackendClient
    let kind: ReviewKind
    let review: ReviewEnvelope
    @State private var details: ReviewValue?
    @State private var openedRevision: Int?
    @State private var openedID: String?
    @State private var openedPlan: ReviewValue?
    @State private var readToEnd = false
    @State private var confirmed = false
    @State private var selected: Set<String> = []
    @State private var waiting = false
    @State private var message: String?
    @State private var endY: CGFloat = .infinity
    @State private var height: CGFloat = 0
    @State private var visibilityTask: Task<Void, Never>?
    @State private var isVisible = false
    @State private var requestGeneration = 0

    private var sameReview: Bool {
        guard let current = kind.review(in: client.state) else { return false }
        return ReviewValidation.current(stage: current.stage, id: current.reviewId, revision: client.state?.deck?.revision,
                                        plan: current.plan, openedID: openedID, openedRevision: openedRevision, openedPlan: openedPlan, visible: isVisible)
    }
    private var entries: [ReviewValue] { details?.object?["entries"]?.array ?? [] }
    private var canSubmit: Bool {
        !waiting && sameReview && readToEnd && confirmed &&
        (kind != .parcelImport || !selected.isEmpty)
    }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(kind.title).font(.headline)
                    Spacer()
                    Text(stageText).foregroundStyle(.secondary).font(.caption)
                }
                if let text = review.message, !text.isEmpty { Text(text).foregroundStyle(.secondary) }
                if review.stage == "review" {
                    if details == nil {
                        Text(kind.detailPath == nil ? "대상 목록을 확인할 수 있습니다." : "전체 대상은 이 버튼을 누른 뒤에만 불러옵니다.")
                            .font(.callout).foregroundStyle(.secondary)
                        Button("검토 내용 열기") { Task { await open() } }.disabled(waiting || review.reviewId == nil)
                    } else if let details {
                        if !sameReview {
                            Label("화면이나 검토 대상이 바뀌었습니다. 내용을 다시 여세요.", systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.orange)
                            Button("다시 열기") { Task { await open() } }.disabled(waiting)
                        }
                        ScrollView {
                            VStack(alignment: .leading, spacing: 8) {
                                ReviewDetails(value: details)
                                GeometryReader { geometry in
                                    Color.clear.preference(key: ReviewEndKey.self, value: geometry.frame(in: .named("review-details-\(kind.rawValue)")).maxY)
                                }.frame(height: 1)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                        }
                        .coordinateSpace(name: "review-details-\(kind.rawValue)")
                        .frame(minHeight: 180, maxHeight: 300)
                        .background(GeometryReader { geometry in Color.clear.preference(key: ReviewHeightKey.self, value: geometry.size.height) })
                        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
                        .onPreferenceChange(ReviewEndKey.self) { value in endY = value; updateReadState() }
                        .onPreferenceChange(ReviewHeightKey.self) { value in height = value; updateReadState() }
                        Text(readToEnd ? "전체 내용의 끝을 확인했습니다." : "전체 내용을 끝까지 스크롤해 확인하세요.")
                            .font(.caption).foregroundStyle(.secondary)
                        if kind == .parcelImport {
                            Text("이 Mac에 저장할 항목을 선택하세요. 외부 조회는 이 단계에서 실행하지 않습니다.")
                            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                                if let item = entry.object, let id = item["id"]?.string,
                                   let tracking = item["tracking"]?.string {
                                    Toggle(isOn: Binding(get: { selected.contains(id) }, set: { if $0 { selected.insert(id) } else { selected.remove(id) } })) {
                                        Text("\(item["title"]?.string ?? "배송") · \(tracking)\(item["exists"]?.bool == true ? " · 이미 등록됨" : "")")
                                    }.disabled(item["exists"]?.bool == true)
                                }
                            }
                        }
                        if kind.requiresPhysicalConfirmation || kind == .parcelImport {
                            Toggle("전체 대상과 내용을 확인했습니다", isOn: $confirmed)
                                .disabled(!readToEnd || !sameReview || waiting)
                            if kind.requiresPhysicalConfirmation {
                                Text("확인 후 293S에서 해당 키를 길게 눌러 실행합니다.").font(.caption).foregroundStyle(.secondary)
                                Button(review.reviewed == true ? "확인됨" : "검토 확인") { Task { await submit() } }
                                    .disabled(!canSubmit || review.reviewed == true)
                            } else {
                                Button("선택 항목 저장") { Task { await submit() } }.disabled(!canSubmit)
                            }
                        } else {
                            Text("현재는 미리보기만 제공하며 실제 삭제는 실행하지 않습니다.").foregroundStyle(.secondary)
                        }
                    }
                }
                if let message { Text(message).font(.callout).foregroundStyle(.secondary) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
        }
        .onAppear { isVisible = true }
        .onDisappear {
            isVisible = false; requestGeneration &+= 1; visibilityTask?.cancel()
            details = nil; openedID = nil; openedPlan = nil; openedRevision = nil
            confirmed = false; readToEnd = false; selected = []; message = nil
        }
    }

    private var stageText: String {
        switch review.stage {
        case "review": return review.reviewed == true ? "기기 확인 대기" : "검토 필요"
        case "loading": return "불러오는 중"
        case "running": return "실행 중"
        case "completed": return "완료"
        default: return "확인 필요"
        }
    }
    private func updateReadState() {
        visibilityTask?.cancel()
        guard height > 0, endY > 0, endY <= height + 2 else { return }
        // Wait for layout to settle: an early geometry pass must not mark a
        // long, still-loading document as read.
        visibilityTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled, height > 0, endY > 0, endY <= height + 2 else { return }
            readToEnd = true
        }
    }
    private func open() async {
        guard isVisible, review.stage == "review", let id = review.reviewId, let plan = review.plan,
              let revision = client.state?.deck?.revision else { return }
        requestGeneration &+= 1
        let expectedGeneration = requestGeneration
        waiting = true; defer { waiting = false }
        visibilityTask?.cancel()
        details = nil; openedID = nil; openedPlan = nil; openedRevision = nil; confirmed = false; readToEnd = false; selected = []; message = nil
        endY = .infinity; height = 0
        do {
            let result: ReviewValue
            if kind.detailPath != nil {
                result = try await ReviewTransport(service: client.service).detail(kind: kind, id: id)
                guard ReviewValidation.valid(kind: kind.rawValue, id: id, plan: plan, detail: result) else { throw ReviewRequestError.unavailable }
            } else { result = plan }
            guard isVisible, requestGeneration == expectedGeneration,
                  let current = kind.review(in: client.state), current.stage == "review", current.reviewId == id,
                  current.plan == plan, client.state?.deck?.revision == revision else { throw ReviewRequestError.stale }
            openedID = id; openedPlan = plan; openedRevision = revision; details = result
        } catch { message = error.localizedDescription }
    }
    private func submit() async {
        guard canSubmit, let id = openedID, let revision = openedRevision else { return }
        waiting = true; defer { waiting = false }
        do {
            if kind == .parcelImport {
                try await ReviewTransport(service: client.service).applyImport(id: id, revision: revision, selected: selected.sorted())
                message = "선택 항목을 저장했습니다."
            } else {
                try await ReviewTransport(service: client.service).acknowledge(kind: kind, id: id, revision: revision)
                message = "검토를 확인했습니다. 기기에서 해당 키를 길게 누르세요."
            }
            await client.refresh()
        } catch { message = error.localizedDescription }
    }
}

private struct ReviewDetails: View {
    let value: ReviewValue
    var body: some View {
        switch value {
        case .object(let dictionary):
            VStack(alignment: .leading, spacing: 8) {
                ForEach(dictionary.keys.filter { $0 != "reviewId" && $0 != "id" }.sorted(), id: \.self) { key in
                    if let value = dictionary[key] {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(label(key)).font(.caption.bold()).foregroundStyle(.secondary)
                            ReviewDetails(value: value)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        case .array(let items):
            VStack(alignment: .leading, spacing: 9) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    VStack(alignment: .leading, spacing: 3) {
                        if items.count > 1 { Text("\(index + 1) / \(items.count)").font(.caption).foregroundStyle(.secondary) }
                        ReviewDetails(value: item)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        default:
            Text(value.display).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func label(_ key: String) -> String {
        ["destination": "전송 대상", "targets": "전체 대상", "entries": "항목", "tracking": "운송장 번호", "title": "이름", "host": "호스트", "port": "포트", "operation": "작업", "scope": "범위", "files": "변경 파일", "diff": "전체 변경 내용", "current": "현재 버전", "target": "대상 버전", "path": "경로", "count": "개수", "source": "출처"][key] ?? key
    }
}
