import Foundation

@main
struct MotionLogicTests {
    static func main() {
        let value: [String: Any] = ["id": "hover", "on": "boardHover", "tracks": [
            ["prop": "translateX", "duration": 180, "ease": "easeOut"],
            ["prop": "opacity", "ease": ["spring": ["duration": 420, "bounce": 0.2]]],
            ["prop": "rotate", "ease": ["spring": ["mass": 1, "stiffness": 100, "damping": 12]]],
            ["prop": "scale", "ease": [0.1, 0.2, 0.3, 0.4]],
        ]]
        let motion = MotionAnimation(value)
        precondition(motion?.id == "hover" && motion?.trigger == "Board hover")
        precondition(motion?.tracks == [
            "Move X, 180 ms, Ease out", "Opacity, 420 ms, Spring", "Rotate, Until settled, Spring", "Scale, 300 ms, Cubic bezier",
        ])
        precondition(MotionAnimation([:]) == nil)
        print("ok: motion inspector")
    }
}
