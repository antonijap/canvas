// swiftc -parse-as-library ShellLogic.swift SettingsLogic.swift CloudPicker.swift Tests/CloudPickerTests.swift -o /tmp/cloud-picker-tests
import AppKit

@main
struct CloudPickerTests {
    static func main() {
        let clouds = (1...3).map { CloudEntry(url: "https://team\($0).example.com", name: "Cloud", kind: .server) }
        let menu = CloudSharePicker.make(clouds, name: { $0.name }, detail: { _ in "server" })
        precondition(menu.numberOfItems == 3, "all three duplicate names remain selectable")
        for i in clouds.indices {
            menu.selectItem(at: i)
            precondition(CloudSharePicker.selected(menu, in: clouds)?.url == clouds[i].url, "selection maps to the Cloud shown")
        }
        precondition(Set(menu.itemTitles).count == 3, "titles distinguish duplicate Cloud names")
        print("ok: 5 checks")
    }
}
