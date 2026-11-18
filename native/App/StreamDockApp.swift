import AppKit
import ServiceManagement
import SwiftUI

@MainActor final class AppLifecycle: NSObject, NSApplicationDelegate {
    weak var client: BackendClient?
    func applicationWillTerminate(_ notification: Notification) { client?.stop() }
}

@main struct StreamDockApp: App {
    @NSApplicationDelegateAdaptor(AppLifecycle.self) private var lifecycle
    @StateObject private var client: BackendClient

    init() {
        let service = BackendService()
        _client = StateObject(wrappedValue: BackendClient(service: service))
    }

    var body: some Scene {
        Window("StreamDock AI", id: "main") {
            MainView(client: client)
                .frame(minWidth: 880, minHeight: 600)
                .task { lifecycle.client = client; client.start() }
        }
        .defaultSize(width: 1100, height: 740)

        Settings {
            PreferencesView(client: client)
                .frame(minWidth: 560, minHeight: 420)
                .task { lifecycle.client = client; client.start() }
        }

        MenuBarExtra("StreamDock AI", systemImage: "square.grid.3x3.fill") {
            MenuBarContent(client: client)
        }
    }
}

private struct MenuBarContent: View {
    @ObservedObject var client: BackendClient
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(client.state?.device.connected == true ? "293S 연결됨" : "293S 연결 확인 중")
        Divider()
        Button("대시보드 열기") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
        Button("상태 갱신") { Task { await client.refreshStatus() } }
            .disabled(client.state == nil || client.busy)
        Button("사용량 갱신") { Task { await client.refreshUsage() } }
            .disabled(client.state == nil)
        Divider()
        Button("종료") { NSApp.terminate(nil) }
    }
}

private enum Page: String, CaseIterable, Identifiable {
    case device = "기기"
    case agents = "에이전트와 사용량"
    case settings = "설정"
    case providers = "외부 서비스"
    case reviews = "요청 검토"
    case diagnostics = "연결과 진단"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .device: return "square.grid.3x3"
        case .agents: return "person.2.wave.2"
        case .settings: return "gearshape"
        case .providers: return "network"
        case .reviews: return "checklist"
        case .diagnostics: return "checkmark.shield"
        }
    }
}

private struct MainView: View {
    @ObservedObject var client: BackendClient
    @ObservedObject private var service: BackendService
    @State private var page: Page? = .device

    init(client: BackendClient) {
        self.client = client
        self.service = client.service
    }

    var body: some View {
        NavigationSplitView {
            List(Page.allCases, selection: $page) { item in
                Label(item.rawValue, systemImage: item.icon).tag(item)
            }
            .navigationSplitViewColumnWidth(min: 185, ideal: 210)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 7) {
                    Circle().fill(client.state?.device.connected == true ? Color.green : Color.secondary).frame(width: 8, height: 8)
                    Text(client.state?.device.connected == true ? "293S 연결됨" : "기기 연결 확인 중")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }.padding(12)
            }
        } detail: {
            Group {
                switch page ?? .device {
                case .device: DeviceView(client: client, openReviews: { page = .reviews })
                case .agents: AgentsView(client: client)
                case .settings: PreferencesView(client: client)
                case .providers: ProviderSettingsView(client: client)
                case .reviews: ReviewPanel(client: client)
                case .diagnostics: DiagnosticsView(client: client, service: service)
                }
            }
            .navigationTitle((page ?? .device).rawValue)
            .overlay(alignment: .bottom) {
                if let message = client.errorMessage {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill")
                        Text(message)
                        Spacer()
                        Button("닫기") { client.errorMessage = nil }.buttonStyle(.borderless)
                    }.padding(10).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10)).padding()
                }
            }
        }
    }
}

private struct DeviceView: View {
    @ObservedObject var client: BackendClient
    var openReviews: () -> Void
    // Ratios come from the physical 293S: the right strip is narrower than
    // a key, and the spaces between keys are proportional to the key size.
    private let keySpacingRatio: CGFloat = 0.18
    private let rowSpacingRatio: CGFloat = 0.16
    private let sideSpacingRatio: CGFloat = 0.22
    private let sideWidthRatio: CGFloat = 0.68
    private let sideHeightRatio: CGFloat = 0.95
    private let sideTopInsetRatio: CGFloat = 0.025

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("StreamDock 293S").font(.largeTitle.bold())
                        Text("키를 누르면 기기와 같은 동작을 실행합니다.").foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { Task { await client.refreshStatus() } } label: {
                        Label("상태 갱신", systemImage: "arrow.clockwise")
                    }
                    .disabled(client.state == nil || client.busy)
                    if client.state?.device.connected == true {
                        Label("연결됨", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        Label("연결 안 됨", systemImage: "cable.connector.slash").foregroundStyle(.secondary)
                    }
                }
                if let deck = client.state?.deck {
                    if deck.mode == "scenes", deck.frames?.isEmpty == false {
                        Label("나가려면 293S 맨 아래 줄 맨 오른쪽 키를 1.2초 이상 누른 뒤 놓으세요.", systemImage: "hand.tap")
                            .font(.callout)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
                    }
                    if hasReview {
                        HStack {
                            Label("확인이 필요한 요청이 있습니다.", systemImage: "exclamationmark.bubble")
                            Spacer()
                            Button("요청 검토", action: openReviews)
                        }.padding(12).background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                    }
                    HStack {
                        Text(deck.title ?? deckTitle(deck)).font(.headline)
                        Spacer()
                        Text("\(deck.page ?? 1) / \(deck.pages ?? 1)").monospacedDigit().foregroundStyle(.secondary)
                    }
                    GeometryReader { geometry in
                        let widthUnits = 5 + 4 * keySpacingRatio + sideSpacingRatio + sideWidthRatio
                        let keySize = max(0, geometry.size.width / widthUnits)
                        let keySpacing = keySize * keySpacingRatio
                        let rowSpacing = keySize * rowSpacingRatio
                        let gridWidth = 5 * keySize + 4 * keySpacing
                        let gridHeight = 3 * keySize + 2 * rowSpacing
                        // Scene/game artwork uses the original three-slot geometry.
                        // The normal summary clock sits lower on the physical 293S.
                        let animated = (deck.mode == "scenes" || deck.mode == "games") && deck.frames?.isEmpty == false
                        let clockOffset = animated ? 0 : keySize * 0.20
                        let columns = Array(repeating: GridItem(.fixed(keySize), spacing: keySpacing), count: 5)
                        HStack(alignment: .top, spacing: keySize * sideSpacingRatio) {
                            LazyVGrid(columns: columns, spacing: rowSpacing) {
                                ForEach(deck.keys, id: \.index) { key in
                                    Button { Task { await client.press(key) } } label: {
                                        KeyPreview(key: key, frame: deck.frames?.first(where: { $0.index == key.index }) ?? deck.keyFrames?.first(where: { $0.index == key.index }))
                                            .frame(width: keySize, height: keySize)
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(key.disabled == true || key.action == "none" || client.busy)
                                    .accessibilityLabel([key.label, key.caption, key.detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
                                }
                            }
                            .frame(width: gridWidth, height: gridHeight, alignment: .topLeading)
                            SidePreview(frames: deck.sideFrames, summary: client.state?.summary,
                                        rowHeight: keySize * sideHeightRatio,
                                        rowSpacing: rowSpacing * sideHeightRatio,
                                        clockOffset: clockOffset)
                                .frame(width: keySize * sideWidthRatio, height: gridHeight * sideHeightRatio + clockOffset * 0.5)
                                .offset(y: keySize * sideTopInsetRatio)
                        }
                    }
                    .aspectRatio((5 + 4 * keySpacingRatio + sideSpacingRatio + sideWidthRatio) / (3 + 2 * rowSpacingRatio), contentMode: .fit)
                    .frame(maxWidth: 840, alignment: .leading)
                    Text("실제 기기와 화면 내용이 바뀌면 미리보기도 갱신됩니다.")
                        .font(.caption).foregroundStyle(.secondary)
                    if let message = deck.message, !message.isEmpty {
                        Label(message, systemImage: "info.circle").font(.callout).foregroundStyle(.secondary)
                    }
                } else {
                    ContentUnavailableView("기기를 확인하고 있습니다", systemImage: "cable.connector", description: Text("장치와 앱 엔진의 연결 상태를 확인하세요."))
                        .frame(maxWidth: .infinity, minHeight: 320)
                }
                if let warnings = client.state?.warnings, !warnings.isEmpty {
                    ForEach(warnings, id: \.self) { warning in Label(warning, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                }
            }.padding(24)
        }
    }

    private func deckTitle(_ deck: DeckState) -> String {
        switch deck.view {
        case "projects": return "프로젝트"
        case "sessions": return "세션"
        case "usage": return "사용량"
        case "hub": return "기능"
        default: return "기기 화면"
        }
    }

    private var hasReview: Bool {
        guard let state = client.state else { return false }
        return [state.cleanup, state.worktreeReview, state.parcelReview, state.parcelImportReview, state.remoteReview, state.updateReview].contains { $0?.stage == "review" }
    }
}

private struct KeyPreview: View {
    var key: DeckKey
    var frame: PreviewFrame?

    private var color: Color {
        switch key.state {
        case "working", "running", "active": return .mint
        case "blocked", "waiting": return .orange
        case "error": return .red
        case "done": return .blue
        default: return .secondary
        }
    }

    private var meterColor: Color {
        guard let meter = key.bar, let value = meter.value else { return color }
        if meter.stale == true { return .gray }
        let risk = ["free", "charge", "score"].contains(meter.direction ?? "") ? 100 - value : value
        return risk >= (meter.criticalAt ?? 90) ? .red : risk >= (meter.warningAt ?? 70) ? .orange : .mint
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 8).fill(Color(red: 0.05, green: 0.08, blue: 0.11))
                if let image = frame?.image {
                    Image(nsImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(key.label ?? "").font(.system(size: min(17, geo.size.width * 0.16), weight: .bold)).lineLimit(2)
                        Spacer(minLength: 1)
                        if let bytes = key.memory?.usedBytes, key.memory?.estimated == true {
                            Text("약 \(bytes / 1_073_741_824, specifier: "%.1f")GB")
                                .font(.system(size: min(14, geo.size.width * 0.14), weight: .semibold)).lineLimit(1).minimumScaleFactor(0.65)
                        }
                        Text(caption).font(.system(size: min(17, geo.size.width * 0.16), weight: .bold)).foregroundStyle(color).lineLimit(2).minimumScaleFactor(0.65)
                        if let value = barValue, value.isFinite, (0...100).contains(value) {
                            GeometryReader { bar in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Color.white.opacity(0.18))
                                    Capsule().fill(meterColor).frame(width: max(0, bar.size.width * value / 100))
                                }
                            }.frame(height: 5).padding(.top, 2)
                        }
                    }.foregroundStyle(.white).padding(8)
                }
            }
        }
    }

    private var caption: String {
        if key.kind == "quota" { return key.usedPercent.map { "\(Int($0.rounded()))%" } ?? "미확인" }
        if key.kind == "quota-reset" { return [key.resetDate, key.resetTime].compactMap { $0 }.joined(separator: " ") }
        return key.caption ?? ""
    }
    private var barValue: Double? {
        if key.kind == "quota" { return key.usedPercent }
        return key.bar?.value
    }
}

private struct SidePreview: View {
    var frames: [PreviewFrame]?
    var summary: DeckSummary?
    var rowHeight: CGFloat
    var rowSpacing: CGFloat
    var clockOffset: CGFloat

    var body: some View {
        GeometryReader { geo in
            // Keep each source square undistorted. The summary's final frame
            // sits lower on the 293S, so reserve space below it for every pixel.
            VStack(spacing: rowSpacing) {
                ForEach(16...18, id: \.self) { slot in
                    let offset = slot == 18 ? clockOffset : 0
                    ZStack(alignment: .top) {
                        Color(red: 0.05, green: 0.08, blue: 0.11)
                        Group {
                            if let frame = frames?.first(where: { $0.slot == slot }), let image = frame.image {
                                Image(nsImage: image).resizable().scaledToFit()
                            } else {
                                sideText(slot).font(.system(size: min(11, geo.size.width * 0.16), weight: .semibold)).foregroundStyle(.white).multilineTextAlignment(.leading).padding(5)
                            }
                        }
                        .frame(width: geo.size.width, height: rowHeight)
                        .offset(y: offset)
                    }
                    .frame(width: geo.size.width, height: rowHeight + offset * 0.5)
                    .clipped()
                }
            }
            .background(Color(red: 0.05, green: 0.08, blue: 0.11))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .accessibilityLabel("오른쪽 요약 화면")
    }

    private func sideText(_ slot: Int) -> Text {
        guard let summary else { return Text("확인 중") }
        switch slot {
        case 16: return Text("작업 \(summary.working ?? 0)\n확인 \(summary.blocked ?? 0)\n완료 \(summary.done ?? 0)")
        case 17: return Text(summary.warning == true ? "알림 확인" : (summary.attentionProject ?? "알림 없음"))
        default: return Text("갱신\n\(summary.time ?? "--:--")")
        }
    }
}

private struct AgentsView: View {
    @ObservedObject var client: BackendClient
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("에이전트와 사용량").font(.largeTitle.bold())
                        Text("현재 열려 있는 세션과 확인된 계정 정보를 표시합니다.").foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("사용량 갱신") { Task { await client.refreshUsage() } }.disabled(client.state == nil)
                }
                GroupBox("계정 사용량") {
                    if let accounts = client.state?.usage?.accounts, !accounts.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(Array(accounts.enumerated()), id: \.offset) { _, account in
                                HStack(alignment: .top) {
                                    Text(account.label ?? account.provider ?? "계정").fontWeight(.semibold).frame(width: 120, alignment: .leading)
                                    if let windows = account.windows, !windows.isEmpty {
                                        VStack(alignment: .leading) {
                                            ForEach(Array(windows.enumerated()), id: \.offset) { _, window in
                                                Text("\(window.label ?? "한도")  ·  \(window.usedPercent.map { "\(Int($0.rounded()))% 사용" } ?? "미확인")  ·  \(window.resetLabel ?? window.resetsAt ?? "리셋 미확인")")
                                            }
                                        }
                                    } else { Text("사용량을 확인할 수 없습니다.").foregroundStyle(.secondary) }
                                    Spacer()
                                    Text(account.status == "ok" ? "연결됨" : account.status == "stale" ? "이전 값" : "미확인").foregroundStyle(.secondary)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                    } else { Text("아직 계정 정보를 확인하지 못했습니다.").frame(maxWidth: .infinity, alignment: .leading).foregroundStyle(.secondary) }
                }
                if client.state?.claudeAccessibilityRequired == true {
                    AccessibilityHelpView()
                }
                GroupBox("열린 세션") {
                    let sessions = (client.state?.agents ?? []).filter { $0.presence == "live" && $0.isSubagent != true }
                    if sessions.isEmpty {
                        Text("열린 세션을 확인하지 못했습니다.").frame(maxWidth: .infinity, alignment: .leading).foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .leading, spacing: 7) {
                            ForEach(Array(sessions.prefix(50))) { agent in
                                HStack {
                                    Image(systemName: "circle.fill").font(.system(size: 8)).foregroundStyle(agent.status == "working" ? Color.mint : agent.status == "blocked" ? Color.orange : Color.secondary)
                                    Text(agent.project ?? "프로젝트 미확인").fontWeight(.medium).frame(width: 160, alignment: .leading).lineLimit(1)
                                    Text(agent.name ?? agent.title ?? agent.provider ?? "세션").lineLimit(1)
                                    Spacer()
                                    Text(sessionState(agent)).foregroundStyle(.secondary)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                Text("세션을 열려면 기기 화면에서 프로젝트를 선택한 뒤 세션 키를 누르세요. 훅 신뢰 여부는 Codex 또는 Claude의 설정에서 확인해야 합니다.")
                    .font(.callout).foregroundStyle(.secondary)
            }.padding(24)
        }
    }

    private func sessionState(_ agent: AgentState) -> String {
        let value: String
        switch agent.status {
        case "working": value = "작업 중"
        case "blocked": value = "확인 필요"
        case "done": value = "완료"
        case "idle": value = "대기"
        default: value = "미확인"
        }
        return value + (agent.confidence == "inferred" ? "?" : "")
    }
}

private struct PreferencesView: View {
    @ObservedObject var client: BackendClient
    @State private var language = "ko"
    @State private var sound = false
    @State private var screenEnabled = false
    @State private var idleMinutes = 15
    @State private var scene = "aquarium"
    @State private var brightness = 50.0
    @State private var brightnessChanged = false
    @State private var saving = false
    @State private var message: String?
    @State private var loaded = false
    @State private var initial: AppSettings?
    @State private var loginStatus: SMAppService.Status = .notRegistered
    @State private var loginMessage: String?

    var body: some View {
        Form {
            Section("일반") {
                Picker("기기 표시 언어", selection: $language) { Text("한국어").tag("ko"); Text("English").tag("en") }
                Toggle("효과음 사용", isOn: $sound)
                Toggle("로그인 시 앱 실행", isOn: Binding(get: { LoginItemPresentation(loginStatus).enabled }, set: { changeLoginItem($0) }))
                Text("로그인 실행 설정은 macOS에 즉시 적용됩니다.").font(.caption).foregroundStyle(.secondary)
                if let loginMessage { Text(loginMessage).font(.caption).foregroundStyle(.secondary) }
            }
            Section("293S") {
                HStack {
                    Text("밝기")
                    Slider(value: $brightness, in: 0...100, step: 1) { Text("밝기") } onEditingChanged: { changed in if !changed { brightnessChanged = true } }
                    Text("\(Int(brightness))%").monospacedDigit().frame(width: 45, alignment: .trailing)
                }
                if client.state?.settings?.brightness == nil && !brightnessChanged {
                    Text("저장된 밝기 설정이 없습니다. 조절하면 기기에 적용합니다.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("화면보호기") {
                Toggle("사용하지 않을 때 화면보호기 켜기", isOn: $screenEnabled)
                Stepper("대기 시간: \(idleMinutes)분", value: $idleMinutes, in: 1...1440).disabled(!screenEnabled)
                Picker("장면", selection: $scene) {
                    Text("수족관").tag("aquarium"); Text("불멍").tag("fire"); Text("비").tag("rain"); Text("바다").tag("beach")
                }.disabled(!screenEnabled)
            }
            Section {
                HStack {
                    if let message { Text(message).foregroundStyle(.secondary) }
                    Spacer()
                    Button("다시 불러오기") { load() }.disabled(client.state?.settings == nil || saving)
                    Button("저장") { Task { await save() } }.keyboardShortcut(.defaultAction).disabled(!loaded || saving)
                }
            }
            Section {
                Text("외부 서비스 연결은 사이드바에서 설정할 수 있습니다. 에이전트 훅의 신뢰 여부는 해당 앱에서 확인하세요.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { load(); refreshLoginStatus() }
        .onChange(of: client.state?.settings) { _, _ in if !loaded { load() } }
    }

    private func load() {
        guard let settings = client.state?.settings else { return }
        language = settings.language
        sound = settings.sound.enabled
        screenEnabled = settings.screensaver.enabled
        idleMinutes = settings.screensaver.idleMinutes
        scene = settings.screensaver.scene
        if let value = settings.brightness { brightness = Double(value) }
        brightnessChanged = false
        initial = settings
        loaded = true
        message = nil
    }
    private func save() async {
        guard let baseline = initial, let current = client.state?.settings else { message = "설정을 다시 불러오세요."; return }
        guard baseline == current else { message = "다른 곳에서 설정이 변경됐습니다. 다시 불러오세요."; return }
        saving = true
        defer { saving = false }
        var body: [String: Any] = [:]
        if language != baseline.language { body["language"] = language }
        if sound != baseline.sound.enabled { body["sound"] = ["enabled": sound] }
        var screen: [String: Any] = [:]
        if screenEnabled != baseline.screensaver.enabled { screen["enabled"] = screenEnabled }
        if idleMinutes != baseline.screensaver.idleMinutes { screen["idleMinutes"] = idleMinutes }
        if scene != baseline.screensaver.scene { screen["scene"] = scene }
        if !screen.isEmpty { body["screensaver"] = screen }
        if brightnessChanged { body["brightness"] = Int(brightness) }
        if body.isEmpty { message = "변경된 설정이 없습니다."; return }
        do { try await client.saveSettings(body); load(); message = "저장했습니다." }
        catch { message = error.localizedDescription }
    }

    private func refreshLoginStatus() {
        loginStatus = SMAppService.mainApp.status
        loginMessage = LoginItemPresentation(loginStatus).message
    }

    private func changeLoginItem(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            refreshLoginStatus()
        } catch {
            refreshLoginStatus()
            loginMessage = "로그인 실행 설정을 변경하지 못했습니다: \(error.localizedDescription)"
        }
    }
}

private struct AccessibilityHelpView: View {
    @State private var couldNotOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Claude 사용량을 읽으려면 접근성 권한을 확인해야 합니다.", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text("시스템 설정의 개인정보 보호 및 보안 → 접근성에서 관련 앱의 허용 상태를 확인한 뒤 사용량을 다시 갱신하세요.")
                .fixedSize(horizontal: false, vertical: true)
            Button("접근성 설정 열기") {
                guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") else { couldNotOpen = true; return }
                couldNotOpen = !NSWorkspace.shared.open(url)
            }
            if couldNotOpen {
                Text("시스템 설정에서 개인정보 보호 및 보안 → 접근성을 직접 열어 주세요.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct DiagnosticsView: View {
    @ObservedObject var client: BackendClient
    @ObservedObject var service: BackendService
    @StateObject private var accessibilityTrust = AccessibilityTrustMonitor()
    var body: some View {
        Form {
            Section("기기") {
                LabeledContent("상태", value: client.state?.device.connected == true ? "연결됨" : "연결 안 됨")
                LabeledContent("모델", value: client.state?.device.model ?? "미확인")
                if let message = client.state?.device.error, !message.isEmpty { Text(message).foregroundStyle(.orange) }
            }
            Section("앱 엔진") {
                Text(service.message).textSelection(.enabled)
                Button("연결 다시 시도") { service.start() }.disabled(service.token != nil)
                Text("공식 StreamDock 앱과 이 앱은 장치를 동시에 제어할 수 없습니다.").font(.caption).foregroundStyle(.secondary)
            }
            Section("에이전트와 권한") {
                LabeledContent("이 앱의 손쉬운 사용 권한", value: accessibilityTrust.isTrusted ? "허용됨" : "허용되지 않음")
                Text("이 앱의 권한 상태입니다. 다른 프로세스의 접근 여부는 별도로 확인해야 합니다.").font(.caption).foregroundStyle(.secondary)
                ForEach(["codex", "claude"], id: \.self) { provider in
                    let info = client.diagnostics[provider] as? [String: Any]
                    let registration = info?["registration"] as? String
                    LabeledContent(provider == "codex" ? "Codex 훅" : "Claude 훅", value: registrationLabel(registration))
                }
                Button("훅 상태 다시 확인") { Task { await client.loadDiagnostics() } }
                Text("등록된 명령만 확인합니다. 훅의 신뢰 상태와 macOS 접근성 권한은 각 앱과 시스템 설정에서 직접 확인하세요.")
                Text("확인되지 않은 상태를 신뢰됨으로 표시하지 않습니다.").font(.caption).foregroundStyle(.secondary)
            }
            if client.state?.claudeAccessibilityRequired == true {
                Section("Claude 사용량") { AccessibilityHelpView() }
            }
            if let warnings = client.state?.warnings, !warnings.isEmpty {
                Section("알림") { ForEach(warnings, id: \.self) { Text($0).textSelection(.enabled) } }
            }
        }.formStyle(.grouped).task {
            accessibilityTrust.refresh()
            await client.loadDiagnostics()
        }
    }

    private func registrationLabel(_ state: String?) -> String {
        switch state {
        case "detected": return "등록 감지 · 신뢰 미확인"
        case "partial": return "일부 감지 · 신뢰 미확인"
        case "absent": return "감지되지 않음"
        default: return "미확인"
        }
    }
}
