import Foundation
import Combine
import Security

/// A local-only identity request must never send its token to a redirected URL.
private final class RejectBackendRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Owns only the backend process launched by this app. It never adopts or
/// terminates an existing listener, which might own the physical device.
@MainActor
final class BackendService: ObservableObject {
    @Published var message = "백엔드를 준비하고 있습니다."
    @Published private(set) var token: String?
    @Published private(set) var baseURL: URL

    private let port: Int
    private var child: Process?
    private var startupTask: Task<Void, Never>?
    private var generation = 0

    init(port: Int = 4174) {
        precondition((1...65535).contains(port))
        self.port = port
        self.baseURL = URL(string: "http://127.0.0.1:\(port)")!
    }

    func start() {
        guard child == nil, startupTask == nil else { return }
        generation += 1
        let expected = generation
        token = nil
        message = "백엔드를 시작하고 있습니다."
        startupTask = Task { [self] in
            defer { if generation == expected { startupTask = nil } }
            do {
                let randomToken = try Self.newToken()
                let paths = try Self.bundlePaths()
                // Never attach to an already-running service based on a public
                // identity response. Let the user resolve the port conflict.
                if await Self.listenerPID(port: port) != nil {
                    message = "포트 \(port)가 사용 중입니다. 실행 중인 기존 StreamDock 앱을 종료해 주세요."
                    return
                }
                let process = Process()
                process.executableURL = paths.node
                process.arguments = [paths.server.path, "--device"]
                process.currentDirectoryURL = paths.backend
                var environment = ProcessInfo.processInfo.environment
                environment.removeValue(forKey: "NODE_OPTIONS")
                environment.removeValue(forKey: "NODE_PATH")
                // The bundled Swift bridge is the default. Explicitly choosing
                // --node-hid restores the previous driver for troubleshooting.
                // Never accept an arbitrary helper path inherited from the shell.
                environment.removeValue(forKey: "STREAMDOCK_SWIFT_HID_PATH")
                if !CommandLine.arguments.contains("--node-hid") {
                    let bridge = paths.node.deletingLastPathComponent().appendingPathComponent("streamdock-hid")
                    guard FileManager.default.isExecutableFile(atPath: bridge.path) else { throw BackendError.missingRuntime }
                    environment["STREAMDOCK_SWIFT_HID_PATH"] = bridge.path
                }
                environment["PORT"] = String(port)
                environment["STREAMDOCK_NATIVE_TOKEN"] = randomToken
                environment["PATH"] = Self.runtimePath(paths.pathList, inherited: environment["PATH"])
                process.environment = environment
                process.standardInput = FileHandle.nullDevice
                process.standardOutput = FileHandle.nullDevice
                process.standardError = FileHandle.nullDevice
                process.terminationHandler = { [weak self] stopped in
                    Task { @MainActor in
                        guard let self, self.child === stopped else { return }
                        self.child = nil
                        self.token = nil
                        self.message = "백엔드가 종료됐습니다. 앱을 다시 시작해 주세요."
                    }
                }
                try process.run()
                guard generation == expected, !Task.isCancelled else {
                    if process.isRunning { process.terminate() }
                    return
                }
                child = process
                for _ in 0..<120 {
                    guard generation == expected, !Task.isCancelled else { return }
                    guard process.isRunning else { throw BackendError.exited }
                    // Confirm that the spawned PID owns the listening socket
                    // before sending the one-time token to the port.
                    if await Self.listenerPID(port: port) == process.processIdentifier,
                       await Self.validateIdentity(baseURL, token: randomToken) {
                        guard generation == expected, process.isRunning else { return }
                        token = randomToken
                        message = "백엔드가 연결됐습니다."
                        return
                    }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                throw BackendError.timeout
            } catch is CancellationError {
                return
            } catch {
                if let process = child, process.isRunning { process.terminate() }
                child = nil
                token = nil
                message = "백엔드를 시작하지 못했습니다: \(error.localizedDescription)"
            }
        }
    }

    func stop() {
        generation += 1
        startupTask?.cancel()
        startupTask = nil
        token = nil
        if let process = child, process.isRunning { process.terminate() }
        child = nil
        message = "백엔드를 종료했습니다."
    }

    private enum BackendError: LocalizedError {
        case missingRuntime, random, exited, timeout
        var errorDescription: String? {
            switch self {
            case .missingRuntime: return "앱에 포함된 백엔드 파일을 찾을 수 없습니다."
            case .random: return "보안 연결을 준비할 수 없습니다."
            case .exited: return "백엔드가 시작 중 종료됐습니다. 포트와 장치 연결을 확인해 주세요."
            case .timeout: return "백엔드 연결 확인 시간이 초과됐습니다."
            }
        }
    }

    private struct BundlePaths {
        let node: URL
        let backend: URL
        let server: URL
        let pathList: URL
    }

    private static func bundlePaths() throws -> BundlePaths {
        guard let resource = Bundle.main.resourceURL else { throw BackendError.missingRuntime }
        let backend = resource.appendingPathComponent("backend", isDirectory: true)
        let node = resource.appendingPathComponent("runtime/node")
        let server = backend.appendingPathComponent("src/server.mjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.isReadableFile(atPath: server.path) else { throw BackendError.missingRuntime }
        return BundlePaths(node: node, backend: backend, server: server,
                           pathList: resource.appendingPathComponent("runtime/paths.txt"))
    }

    private static func newToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw BackendError.random }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private static func runtimePath(_ file: URL, inherited: String?) -> String {
        let recorded = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = recorded.split(whereSeparator: \.isNewline).map(String.init)
            + ["\(home)/.local/bin", "\(home)/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin"]
            + (inherited ?? "").split(separator: ":").map(String.init)
            + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        var seen = Set<String>()
        return candidates.filter { $0.hasPrefix("/") && !$0.contains(":") && seen.insert($0).inserted }.joined(separator: ":")
    }

    private nonisolated static func listenerPID(port: Int) async -> Int32? {
        await Task.detached(priority: .utility) {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
            task.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"]
            let output = Pipe()
            task.standardOutput = output
            task.standardError = FileHandle.nullDevice
            do { try task.run() } catch { return nil }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            guard task.terminationStatus == 0,
                  let text = String(data: data, encoding: .utf8) else { return nil }
            let pids = text.split(whereSeparator: \.isNewline).compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
            return pids.count == 1 ? pids[0] : nil
        }.value
    }

    private nonisolated static func validateIdentity(_ base: URL, token: String) async -> Bool {
        guard base.scheme == "http", base.host == "127.0.0.1", base.port != nil else { return false }
        var request = URLRequest(url: base.appendingPathComponent("api/native/identity"))
        request.httpMethod = "GET"
        request.timeoutInterval = 1
        request.setValue(token, forHTTPHeaderField: "X-StreamDock-Native-Token")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: RejectBackendRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["application"] as? String == "streamdock-ai",
                  object["protocol"] as? Int == 1 else { return false }
            return true
        } catch { return false }
    }
}
