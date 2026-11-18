import SwiftUI

// MARK: QA marks

extension View {
    /// Marks this view for pnpm qa:native: a QA build (QA.swift) lays an invisible AppKit view under it that the
    /// harness reads (qa.marks) for the view's frame and label, so scenarios find controls without text
    /// recognition. A normal build compiles this to the view itself.
    func qaID(_ id: String, label: String? = nil) -> some View {
        #if CANVAS_QA
        // Out of hit testing: a click on a marked button's label reaches the button, never the mark's host view.
        background(QAMark(id: id, label: label).allowsHitTesting(false))
        #else
        self
        #endif
    }
    /// A mark labelled with the text the view draws: qa:native finds it as it would find the text on screen.
    func qaText(_ text: String) -> some View { qaID("text", label: text) }
}
