import ServiceManagement

/// Present the system's status without inferring why a service was not found.
struct LoginItemPresentation {
    let enabled: Bool
    let message: String?

    init(_ status: SMAppService.Status) {
        switch status {
        case .enabled:
            enabled = true
            message = nil
        case .requiresApproval:
            enabled = true
            message = "시스템 설정의 로그인 항목에서 이 앱을 허용해야 합니다."
        case .notRegistered:
            enabled = false
            message = nil
        case .notFound:
            enabled = false
            message = "로그인 실행 상태를 확인할 수 없습니다."
        @unknown default:
            enabled = false
            message = "로그인 실행 상태를 확인할 수 없습니다."
        }
    }
}
