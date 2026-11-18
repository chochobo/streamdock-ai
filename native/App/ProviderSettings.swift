import SwiftUI

private enum ProviderKind: String, CaseIterable, Identifiable {
    case market, parcels, remote, credits
    var id: String { rawValue }
    var title: String {
        switch self {
        case .market: return "주식"
        case .parcels: return "택배"
        case .remote: return "원격 Mac"
        case .credits: return "크레딧"
        }
    }
}

private struct ParcelDraft: Identifiable {
    var id = UUID()
    var rowID: String?
    var title = ""
    var tracking = ""
}

private struct HostDraft: Identifiable {
    var id = UUID()
    var rowID: String?
    var label = ""
    var ssh = ""
    var port = "22"
    var machine = true
    var agents = false
    var agy = false
}

private struct CreditDraft {
    var enabled = false
    var source = "agentdeck-cache"
    var dedicatedProfile = false
    var port = "9222"
}

struct ProviderSettingsView: View {
    @ObservedObject var client: BackendClient
    @State private var selected: ProviderKind = .market
    @State private var revision: String?
    @State private var loadState = "확인 중"
    @State private var error: String?
    @State private var busy = false
    @State private var portfolio = ""
    @State private var sectors = ""
    @State private var trackingOptIn = false
    @State private var parcels: [ParcelDraft] = []
    @State private var originalParcelIDs: [String] = []
    @State private var remoteEnabled = false
    @State private var hosts: [HostDraft] = []
    @State private var originalHostIDs: [String] = []
    @State private var flow = CreditDraft()
    @State private var higgsfield = CreditDraft()
    @State private var loadID = UUID()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Picker("서비스", selection: $selected) {
                ForEach(ProviderKind.allCases) { kind in Text(kind.title).tag(kind) }
            }.pickerStyle(.segmented).padding([.horizontal, .top], 20)
            if revision == nil {
                VStack(spacing: 8) {
                    ContentUnavailableView(loadState, systemImage: "network", description: Text(error ?? "이 서비스의 설정을 확인하고 있습니다."))
                    if error != nil { Button("다시 확인") { Task { await load() } } }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Form {
                    switch selected {
                    case .market: marketForm
                    case .parcels: parcelsForm
                    case .remote: remoteForm
                    case .credits: creditsForm
                    }
                    Section {
                        HStack {
                            if let error { Text(error).foregroundStyle(.secondary) }
                            Spacer()
                            Button("다시 불러오기") { Task { await load() } }.disabled(busy)
                            Button("설정 저장") { Task { await save() } }.disabled(busy)
                        }
                    }
                }.formStyle(.grouped).disabled(busy)
            }
        }
        .task(id: selected) { await load() }
    }

    private var marketForm: some View {
        Group {
            Section("보유 종목") {
                Text("종목 코드를 한 줄에 하나씩 입력합니다. 최대 10개입니다.").foregroundStyle(.secondary)
                TextEditor(text: $portfolio).font(.system(.body, design: .monospaced)).frame(minHeight: 90)
            }
            Section("관심 업종") {
                Text("업종 이름을 한 줄에 하나씩 입력합니다.").foregroundStyle(.secondary)
                TextEditor(text: $sectors).frame(minHeight: 80)
            }
            Section {
                Text("저장만으로 조회하지 않습니다. 보유 종목 전송은 기기에서 대상 확인 후 시작합니다.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var parcelsForm: some View {
        Group {
            Section("택배 조회") {
                Toggle("배송 조회 사용", isOn: $trackingOptIn)
                Text("운송장 번호는 조회 대상을 확인한 뒤에만 배송 서비스로 전송됩니다.").font(.caption).foregroundStyle(.secondary)
            }
            Section("운송장") {
                ForEach($parcels) { $parcel in
                    HStack {
                        TextField("이름", text: $parcel.title)
                        TextField("운송장 번호", text: $parcel.tracking).font(.system(.body, design: .monospaced))
                        Button(role: .destructive) { parcels.removeAll { $0.id == parcel.id } } label: { Image(systemName: "minus.circle") }
                            .buttonStyle(.borderless).help("목록에서 제거")
                    }
                }
                Button("운송장 추가", systemImage: "plus") { parcels.append(ParcelDraft()) }.disabled(parcels.count >= 50)
            }
        }
    }

    private var remoteForm: some View {
        Group {
            Section("원격 조회") {
                Toggle("원격 조회 사용", isOn: $remoteEnabled)
                Text("저장만으로 연결하지 않습니다. 조회 전에 호스트와 작업을 확인해야 합니다.").font(.caption).foregroundStyle(.secondary)
            }
            Section("호스트") {
                ForEach($hosts) { $host in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            TextField("표시 이름", text: $host.label)
                            TextField("사용자@호스트", text: $host.ssh).font(.system(.body, design: .monospaced))
                            TextField("포트", text: $host.port).frame(width: 65)
                            Button(role: .destructive) { hosts.removeAll { $0.id == host.id } } label: { Image(systemName: "minus.circle") }
                                .buttonStyle(.borderless).help("호스트 제거")
                        }
                        HStack {
                            Toggle("머신", isOn: $host.machine)
                            Toggle("에이전트", isOn: $host.agents)
                            Toggle("Antigravity", isOn: $host.agy)
                        }.toggleStyle(.checkbox)
                    }.padding(.vertical, 4)
                }
                Button("호스트 추가", systemImage: "plus") { hosts.append(HostDraft()) }.disabled(hosts.count >= 8)
            }
        }
    }

    private var creditsForm: some View {
        Group {
            creditSection("Google Flow", draft: $flow)
            creditSection("Higgsfield", draft: $higgsfield)
            Section {
                Text("브라우저 읽기는 전용 프로필을 직접 준비한 경우에만 사용합니다. 이 앱은 로그인하거나 쿠키를 가져오지 않습니다.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func creditSection(_ title: String, draft: Binding<CreditDraft>) -> some View {
        Section(title) {
            Toggle("사용", isOn: draft.enabled)
            Picker("데이터 출처", selection: draft.source) {
                Text("AgentDeck 캐시").tag("agentdeck-cache")
                Text("로컬 스냅샷").tag("snapshot")
                Text("전용 브라우저").tag("cdp")
            }
            if draft.wrappedValue.source == "cdp" {
                Toggle("전용 프로필을 준비했습니다", isOn: draft.dedicatedProfile)
                TextField("로컬 디버그 포트", text: draft.port).frame(width: 130)
            }
        }
    }

    @MainActor private func load() async {
        let kind = selected
        let requestID = UUID()
        loadID = requestID
        revision = nil
        error = nil
        loadState = "확인 중"
        do {
            let result = try await client.loadProvider(kind.rawValue)
            guard selected == kind, loadID == requestID else { return }
            guard let rev = result["revision"] as? String, let config = result["config"] as? [String: Any] else {
                loadState = "설정을 읽을 수 없습니다"
                error = "기존 설정 파일을 확인하세요. 이 화면에서 덮어쓰지 않습니다."
                return
            }
            populate(kind, config: config)
            revision = rev
        } catch {
            guard selected == kind, loadID == requestID else { return }
            loadState = "설정을 읽을 수 없습니다"
            self.error = "앱 엔진 연결과 설정 파일을 확인하세요."
        }
    }

    @MainActor private func save() async {
        guard let revision else { return }
        let kind = selected
        busy = true
        defer { busy = false }
        do {
            let result = try await client.saveProvider(kind.rawValue, revision: revision, patch: patch(kind))
            guard selected == kind else { return }
            if let config = result["config"] as? [String: Any] { populate(kind, config: config) }
            self.revision = result["revision"] as? String
            error = "저장했습니다."
        } catch {
            guard selected == kind else { return }
            self.error = error.localizedDescription
        }
    }

    private func lines(_ value: String) -> [String] {
        value.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }

    private func patch(_ kind: ProviderKind) -> [String: Any] {
        switch kind {
        case .market: return ["portfolio": lines(portfolio), "favoriteSectors": lines(sectors)]
        case .parcels:
            let rows = parcels.map { parcel in
                var row: [String: Any] = ["title": parcel.title, "tracking": parcel.tracking]
                if let id = parcel.rowID { row["rowId"] = id }
                return row
            }
            let remaining = Set(parcels.compactMap(\.rowID))
            let deleted = originalParcelIDs.filter { !remaining.contains($0) }
            var result: [String: Any] = ["trackingOptIn": trackingOptIn, "parcels": rows]
            if !deleted.isEmpty { result["deletedRowIds"] = deleted }
            return result
        case .remote:
            let rows = hosts.map { host in
                var row: [String: Any] = ["label": host.label, "ssh": host.ssh, "port": Int(host.port) ?? 0,
                 "operations": [(host.machine, "machine"), (host.agents, "agents"), (host.agy, "agy")].compactMap { $0.0 ? $0.1 : nil }]
                if let id = host.rowID { row["rowId"] = id }
                return row
            }
            let remaining = Set(hosts.compactMap(\.rowID))
            let deleted = originalHostIDs.filter { !remaining.contains($0) }
            var result: [String: Any] = ["enabled": remoteEnabled, "hosts": rows]
            if !deleted.isEmpty { result["deletedRowIds"] = deleted }
            return result
        case .credits: return ["sources": ["flow": creditValue(flow), "higgsfield": creditValue(higgsfield)]]
        }
    }

    private func creditValue(_ value: CreditDraft) -> [String: Any] {
        var result: [String: Any] = ["enabled": value.enabled, "source": value.source]
        if value.source == "cdp" { result["dedicatedProfile"] = value.dedicatedProfile; result["port"] = Int(value.port) ?? 0 }
        return result
    }

    private func populate(_ kind: ProviderKind, config: [String: Any]) {
        switch kind {
        case .market:
            portfolio = (config["portfolio"] as? [String] ?? []).joined(separator: "\n")
            sectors = (config["favoriteSectors"] as? [String] ?? []).joined(separator: "\n")
        case .parcels:
            trackingOptIn = config["trackingOptIn"] as? Bool ?? false
            parcels = (config["parcels"] as? [[String: Any]] ?? []).map { ParcelDraft(rowID: $0["rowId"] as? String, title: $0["title"] as? String ?? "", tracking: $0["tracking"] as? String ?? "") }
            originalParcelIDs = parcels.compactMap(\.rowID)
        case .remote:
            remoteEnabled = config["enabled"] as? Bool ?? false
            hosts = (config["hosts"] as? [[String: Any]] ?? []).map { item in
                let operations = item["operations"] as? [String] ?? []
                return HostDraft(rowID: item["rowId"] as? String, label: item["label"] as? String ?? "", ssh: item["ssh"] as? String ?? "", port: String(item["port"] as? Int ?? 22), machine: operations.contains("machine"), agents: operations.contains("agents"), agy: operations.contains("agy"))
            }
            originalHostIDs = hosts.compactMap(\.rowID)
        case .credits:
            let sources = config["sources"] as? [String: [String: Any]] ?? [:]
            flow = creditDraft(sources["flow"])
            higgsfield = creditDraft(sources["higgsfield"])
        }
    }

    private func creditDraft(_ value: [String: Any]?) -> CreditDraft {
        CreditDraft(enabled: value?["enabled"] as? Bool ?? false, source: value?["source"] as? String ?? "agentdeck-cache", dedicatedProfile: value?["dedicatedProfile"] as? Bool ?? false, port: String(value?["port"] as? Int ?? 9222))
    }
}
