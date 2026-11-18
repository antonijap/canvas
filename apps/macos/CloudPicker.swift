// The share picker preserves every Cloud even when their display names repeat.
import AppKit

enum CloudSharePicker {
    static func make(_ clouds: [CloudEntry], name: (CloudEntry) -> String, detail: (CloudEntry) -> String) -> NSPopUpButton {
        let menu = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 260, height: 26), pullsDown: false)
        for (i, title) in CloudShare.titles(clouds, name: name, detail: detail).enumerated() {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.tag = i
            menu.menu?.addItem(item)
        }
        menu.selectItem(withTag: 0)
        menu.setAccessibilityLabel("Cloud")
        return menu
    }

    static func selected(_ menu: NSPopUpButton, in clouds: [CloudEntry]) -> CloudEntry? {
        guard let i = menu.selectedItem?.tag, clouds.indices.contains(i) else { return nil }
        return clouds[i]
    }
}
