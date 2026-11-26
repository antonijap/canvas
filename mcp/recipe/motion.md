## Hover motion

Use `set_motion` with the node ids in playback order. Each animation has an id, `on: "boardHover"`, and tracks. A track gives `prop` and can set `from`, `to`, `duration`, `delay` and `ease`. Canvas uses pixels, degrees and milliseconds. Hovering any part of the board plays the animation.

| Source | Canvas |
| --- | --- |
| Framer Motion `whileHover` | Map x and y to translateX and translateY. Use the target values in tracks with `on: "boardHover"`. Use `transition` for timing. Convert seconds to milliseconds. Use `staggerChildren` as the tool's `stagger` argument. |
| CSS transitions or two-stop keyframes | Copy the start and end values, duration and delay. Convert `cubic-bezier(a,b,c,d)` to `[a,b,c,d]`. Write `ease-in-out` as `easeInOut`. |
| React Spring or Framer Motion physical springs | Put `stiffness`, `damping` and `mass` inside `ease.spring`. For React Spring, use tension for stiffness and friction for damping. Match timing visually. |
| SwiftUI `.onHover` and `withAnimation` | Use the entered state for `to`. `.offset` maps to translateX/Y, `.scaleEffect` to scale/scaleX/scaleY, `.rotationEffect` to rotate, and `.opacity` to opacity. |
| SwiftUI `.spring(duration:bounce:)` | Use `ease.spring: {duration, bounce}` with duration in milliseconds. |
| SwiftUI `.spring(response:dampingFraction:)` | Use `ease.spring: {response, dampingFraction}` with response in seconds. |
| SwiftUI `.interpolatingSpring` | Use the physical spring form. Initial velocity is unsupported. |

A layer uses its stored opacity as the default for `from` and `to`. Translation and rotation default to zero, scale to one. `leave` defaults to `reverse`. Use `reset` for an immediate return or `hold` to retain the current pose. `repeat` counts extra cycles and takes `"infinite"` for a loop. `alternate` reverses every other cycle.

Hovering the individual layer, pressing or appearing, gestures, multi-stop keyframes, layout, paint, corner radius and custom spring solvers are outside this format. Lifts can be skipped when they depend on surrounding paint or overlap later layers. Check the board with `check_design` and use `render_motion` for a timestamped PNG.
