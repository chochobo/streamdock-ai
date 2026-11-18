import Foundation

@main struct ReviewValidationTests {
    static func value(_ object: Any) throws -> ReviewValue {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed])
        return try JSONDecoder().decode(ReviewValue.self, from: data)
    }

    static func check(_ condition: Bool, _ description: String) throws {
        if !condition { throw NSError(domain: description, code: 1) }
    }

    static func main() throws {
        let id = String(repeating: "a", count: 48)
        let fakeID = String(repeating: "b", count: 48)
        let scope = "선택한 항목 전송"
        let parcelPlan: [String: Any] = ["destination": "Cainiao", "scope": scope, "count": 1]
        var parcel: [String: Any] = ["reviewId": id, "destination": "Cainiao", "scope": scope, "count": 1,
                                     "targets": [["title": "테스트", "tracking": "TEST123456"]]]
        func valid(_ kind: String, _ plan: [String: Any], _ detail: [String: Any]) throws -> Bool {
            ReviewValidation.valid(kind: kind, id: id, plan: try value(plan), detail: try value(detail))
        }
        try check(try valid("parcel", parcelPlan, parcel), "valid parcel")
        parcel["reviewId"] = fakeID
        try check(!(try valid("parcel", parcelPlan, parcel)), "wrong review id")
        parcel["reviewId"] = id; parcel["count"] = 2
        try check(!(try valid("parcel", parcelPlan, parcel)), "wrong parcel count")
        parcel["count"] = 1; parcel["scope"] = "다른 대상"
        try check(!(try valid("parcel", parcelPlan, parcel)), "wrong parcel scope")
        parcel["scope"] = scope; parcel["token"] = "private"
        try check(!(try valid("parcel", parcelPlan, parcel)), "private token rejected")

        let remotePlan: [String: Any] = ["label": "Mac", "operation": "machine", "scope": "읽기 전용"]
        var remote: [String: Any] = ["reviewId": id, "label": "Mac", "operation": "machine", "scope": "읽기 전용", "host": "user@example.test", "port": 22]
        try check(try valid("remote", remotePlan, remote), "valid remote")
        remote["scope"] = "다른 범위"
        try check(!(try valid("remote", remotePlan, remote)), "remote scope mismatch")
        remote["scope"] = "읽기 전용"; remote["host"] = "-bad"
        try check(!(try valid("remote", remotePlan, remote)), "invalid host")
        remote["host"] = "user@example.test"; remote["port"] = 65536
        try check(!(try valid("remote", remotePlan, remote)), "invalid port")

        let importPlan: [String: Any] = ["source": "AliExpress 열린 배송 탭", "count": 1]
        let entry: [String: Any] = ["id": String(repeating: "c", count: 20), "title": "AliExpress", "tracking": "ABC12345678", "exists": false]
        var imported: [String: Any] = ["reviewId": id, "source": "AliExpress 열린 배송 탭", "count": 1, "entries": [entry]]
        try check(try valid("parcelImport", importPlan, imported), "valid import")
        imported["entries"] = [entry, entry]
        try check(!(try valid("parcelImport", importPlan, imported)), "duplicate import entry")

        let current = String(repeating: "a", count: 40), target = String(repeating: "b", count: 40)
        let updatePlan: [String: Any] = ["action": "fast-forward", "current": current, "target": target, "count": 1]
        var update: [String: Any] = ["reviewId": id, "action": "fast-forward", "current": current, "target": target,
            "root": "/tmp/test", "branch": "main", "remoteUrl": "https://example.test/project", "files": ["file.txt"],
            "diff": "abc", "diffHash": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"]
        try check(try valid("update", updatePlan, update), "valid update digest")
        update["diff"] = "changed"
        try check(!(try valid("update", updatePlan, update)), "changed diff rejected")
        update["diff"] = "abc"; update["files"] = ["file.txt", "extra.txt"]
        try check(!(try valid("update", updatePlan, update)), "incomplete plan rejected")
        update["files"] = ["file.txt"]; update["target"] = current
        try check(!(try valid("update", updatePlan, update)), "target mismatch")

        let plan = try value(parcelPlan), otherPlan = try value(["destination": "Cainiao", "scope": scope, "count": 2])
        try check(ReviewValidation.current(stage: "review", id: id, revision: 2, plan: plan, openedID: id, openedRevision: 2, openedPlan: plan), "current review")
        try check(!ReviewValidation.current(stage: "review", id: id, revision: 2, plan: plan, openedID: id, openedRevision: 2, openedPlan: plan, visible: false), "dismissed panel")
        try check(!ReviewValidation.current(stage: "cancelled", id: id, revision: 2, plan: plan, openedID: id, openedRevision: 2, openedPlan: plan), "closed review")
        try check(!ReviewValidation.current(stage: "review", id: fakeID, revision: 2, plan: plan, openedID: id, openedRevision: 2, openedPlan: plan), "replaced review")
        try check(!ReviewValidation.current(stage: "review", id: id, revision: 3, plan: plan, openedID: id, openedRevision: 2, openedPlan: plan), "stale revision")
        try check(!ReviewValidation.current(stage: "review", id: id, revision: 2, plan: otherPlan, openedID: id, openedRevision: 2, openedPlan: plan), "changed plan")
        print("Native review validation tests passed")
    }
}
