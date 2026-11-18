import ServiceManagement

@main struct LoginItemPresentationTests {
    static func main() {
        let enabled = LoginItemPresentation(.enabled)
        precondition(enabled.enabled && enabled.message == nil)

        let unregistered = LoginItemPresentation(.notRegistered)
        precondition(!unregistered.enabled && unregistered.message == nil)

        let pending = LoginItemPresentation(.requiresApproval)
        precondition(pending.enabled && pending.message?.contains("시스템 설정") == true)

        let missing = LoginItemPresentation(.notFound)
        precondition(!missing.enabled && missing.message == "로그인 실행 상태를 확인할 수 없습니다.")
        print("Login item status presentation tests passed")
    }
}
