Canvas's small interaction rules: the keys, clicks and drags designers expect from a design tool, and what Canvas does for each today (code read on 2026-11-16).
Drawing-only behaviour (vector drawing, shape and text tools, vector edit) is skipped: in Canvas, agents, paste, drop and duplicate make layers.

How to read the tables:

- Canvas: **HAVE** (where it lives), **PARTIAL** (what is missing), **MISSING**, **IN PROGRESS** (being built now), **SKIP** (why).
- Priority for PARTIAL and MISSING: **P1** a designer notices in the first 10 minutes, **P2** within a day, **P3** power users.
- Size: **S** an afternoon or less, **M** a day or two, **L** more, or it needs a file format change.
- Mac keys throughout.

## Selecting

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Click picks the top-level child | A click inside a group or frame selects the parent level first | **HAVE**: `src/server.ts` pointerup, `src/page/geometry.js` pickTarget | - | - |
| Go one level in | Double-click, or Enter, selects one level of nesting down | **HAVE**: `geometry.js` dblClickTarget, `src/page/structure.js` (Enter) | - | - |
| Select parent | Shift+Enter | **HAVE**: `structure.js` | - | - |
| Select parent, second key | \ (backslash) | **HAVE**: `src/page/structure.js` keyAction (\) | - | - |
| Next or previous sibling | Tab / Shift+Tab | **HAVE**: `src/page/shortcuts.js` stepSibling | - | - |
| Deep select | Cmd+click picks the nested layer under the pointer | **HAVE**: `server.ts` pickSelectable with meta | - | - |
| Deep marquee | Hold Cmd while dragging a selection box to select nested layers | **HAVE**: `structure.js` beginMarquee | - | - |
| Add or remove one layer | Shift+click adds; Shift+click on a selected layer removes it | **HAVE**: `server.ts` pointerup (toggled) | - | - |
| Marquee adds to the selection | Shift+drag on empty canvas keeps the current selection | **HAVE**: `structure.js` (base selection on Shift) | - | - |
| Deselect | Esc, or click empty canvas | **HAVE**: Esc cancels a move, else deselects, a nested layer too (`server.ts` keydown); Shift+Return or \ walks up to the parent | - | - |
| Select all | Cmd+A | **HAVE**: Edit menu, `structure.js` | - | - |
| Select inverse | Shift+Cmd+A: everything except the current selection | **HAVE**: Edit > Select Inverse, `structure.js` selectInverse (Select All's scope minus the selection) | - | - |
| Select all with the same property | Edit > Select All > Fill, Stroke, Effect, Text properties, Font, Instance | **HAVE**: Edit > Select All with Same (Fill, Stroke, Effect, Text Properties, Font, Instances), `src/search.ts` matchActions; also in Cmd+K | - | - |
| Select matching layers | Option+Cmd+A selects layers with the same name in other frames; Shift adds or removes matches | **HAVE**: Option+Cmd+A, Edit > Select Matching Layers: same name and kind in the other boards (`src/search.ts` "matching"); Shift+click adds or removes one | - | - |
| Pick a layer under others | Right-click > Select layer lists the layers under the pointer, locked ones with a padlock | **HAVE**: right-click > Select layer, topmost first (`src/page/context.js` layersAt, engine `hitTestAll`); no padlock yet | - | - |
| Hover outline | The layer under the pointer gets an outline before you click | **HAVE**: `server.ts` hovWorld | - | - |
| Keyboard box selection | Option+Space starts a box you move and size with the arrow keys | **HAVE**: `src/page/keybox.js` (Option+Space, arrows, Return, Cmd+arrows, Esc) | - | - |

## Moving and reparenting

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Drop into a frame | Moving a layer onto a frame nests it; a layer bigger than the frame does not become its child | **HAVE**: `src/page/reparent.js`, `autolayout-logic.js` dropTarget (size check) | - | - |
| Keep the parent while dragging | Hold Space while moving a layer out of a frame's bounds: it stays in its current parent. Holding Space also stops it nesting into the frame it is dropped on | **HAVE**: Space mid-drag keeps the parent for layers, several layers, boards and auto layout children (`server.ts` keepParent, `autolayout.js` keepParent); Space alone still pans. [Evidence](evidence/moving.md) | - | - |
| Keep the parent when adding | Hold Space while adding objects to stop them being reparented | **HAVE**: Space held while pasting puts the paste beside the selected frame (Paste here: on the canvas); a dropped, pasted or placed image goes on the canvas, not into a frame (`structure.js` pastePlace keep, `drop-logic.js` dropParent) | - | - |
| Duplicate by dragging | Option+drag leaves the original and moves a copy | **HAVE**: `server.ts` mv.dup, `shortcuts.js` ghost; Option pressed mid-drag works too | - | - |
| Bypass snapping | Hold Control while dragging to turn off snap to geometry and objects for that drag | **HAVE**: Control skips object snapping on moves and resizes (`snap.js` bypassSnap, `live.js`, `group-resize.js`). Cmd does not: on a move it lets a layer drop into a frame smaller than itself (`autolayout-logic.js` dropTarget). [Evidence](evidence/moving.md) | - | - |
| Move on one axis | Shift while dragging locks to the axis moved most | **HAVE**: `server.ts` (lock on Shift) | - | - |
| Nudge | Arrow keys move by the small nudge (1), Shift+arrows by the big nudge (10), both set in preferences | **HAVE**: `server.ts` nudge, Settings > Canvas big nudge | - | - |
| Duplicate | Cmd+D; a top-level frame goes to the right of the original, other layers on top of it | **HAVE**: `structure.js`; on moved copies Cmd+D repeats their step | - | - |
| Move a frame by its name | Drag the frame's name label on the canvas | **HAVE**: `server.ts` beginMove (board labels) | - | - |
| Drop into auto layout as absolute | Hold Control while dragging a layer into an auto layout frame: it ignores auto layout | **HAVE**: `src/page/autolayout.js`, `reparent.js` (mods.ctrl) | - | - |
| Layer order in auto layout | Cmd+] / Cmd+[ inside an auto layout frame moves the layer's place in the flow | **HAVE**: reorder writes file order, which is flow order; stacking setting in the auto layout popover | - | - |

## Resizing and rotating

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Keep the ratio | Shift while resizing locks the aspect ratio for that drag | **HAVE**: `src/page/live.js` | - | - |
| Resize from the centre | Option while resizing | **HAVE**: `live.js`, `group-resize.js` | - | - |
| Lock aspect ratio | A lock beside W and H keeps the ratio; with it on, Control frees one drag | **HAVE**: the lock in the Dimensions row above W and H (`InspectorLayout.swift` AspectLockButton, `metadata.canvasLockAspect`); typed and scrubbed W or H, handle drags (Control frees one, `src/page/live.js`) and Cmd+arrows keep the ratio | - | - |
| Resize a frame without its children | Hold Cmd while resizing to ignore children's constraints | **HAVE**, adapted: Cmd keeps absolutely placed children where they are on the canvas when the left or top edge moves (`live.js`) | - | - |
| Constraints | Left, Right, Left and right, Center, Scale per child; Shift picks two | **SKIP**: the file format has no constraints; agents use auto layout for responsive frames | - | - |
| Resize several layers | Handles on a multi-selection scale every layer in the box | **HAVE**: `src/page/group-resize.js` | - | - |
| Rotate | Drag just outside a corner; Shift snaps to 15° | **HAVE**: `src/page/rotate.js` | - | - |
| Rotate by keys | Cmd+Option+Up/Down turns the layer 1° | **HAVE**: `src/page/shortcuts.js` rotateKey (every selected layer, one undo step per press) | - | - |
| Move the rotation origin | Option+R shows the origin target; drag it | **HAVE**: `rotate.js` (Option+R, the target snaps to centre, corners and edge middles; absolutely placed layers). [Evidence](evidence/moving.md) | - | - |
| Resize by keys | Cmd+arrows change width and height | **HAVE**: `shortcuts.js` resizeKey | - | - |
| Scale tool | K scales a layer with everything inside it, keeping the ratio | **HAVE**: `live.js`, `src/page/scale.js` | - | - |
| Resize frame to fit | Option+Shift+Cmd+R fits the frame to its outermost children | **HAVE**: `live.js` | - | - |
| Flip | Shift+H / Shift+V | **HAVE**: `shortcuts.js` flip | - | - |
| Resizing text by its box | Dragging a text box edge switches it to Fixed size | **HAVE**: auto width dragged by a side becomes Fixed size at the height it had; a top or bottom edge or a corner makes any text Fixed size (`live-edit.js` textResizeWrites). One exception: a side edge on auto height text keeps auto height, so a widened paragraph keeps fitting its lines | - | - |
| Fit a side to content | Double-click a text box edge to make it auto width or auto height | **HAVE**: double-click an edge fits that side to the content (`live.js`) | - | - |
| Clip content | A frame checkbox hides children past its bounds | **HAVE**: `InspectorLayout.swift` | - | - |

## Auto layout

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Add auto layout | Shift+A | **HAVE**: `autolayout.js`, Object menu | - | - |
| Remove auto layout | Option+Shift+A | **HAVE**: `autolayout.js`, Object menu | - | - |
| Suggest auto layout | Control+Shift+A | **HAVE**, smaller: each selected frame gets auto layout from its own children (the gap they have); nested frames are not converted (`autolayout.js` suggest). [Evidence](evidence/moving.md) | - | - |
| Hug by double-click | Double-click a vertical or horizontal edge: that axis hugs its contents | **HAVE**: `autolayout.js` | - | - |
| Fill by Option+double-click | Option+double-click an edge: that axis fills its container | **HAVE**: `autolayout.js` | - | - |
| Typing a size sets Fixed | A value in W or H, or a manual resize, sets that axis to Fixed | **HAVE**: `InspectorLayout.swift` | - | - |
| Min and max | Set from the Width or Height dropdown | **HAVE**: `InspectorLayout.swift` | - | - |
| Padding handle, opposite side | Option while dragging a padding handle changes the opposite side too | **HAVE**: `autolayout.js` | - | - |
| Padding handle, all sides | Option+Shift while dragging changes all four sides | **HAVE**: `autolayout-logic.js` sidesFor. [Evidence](evidence/moving.md) | - | - |
| Big steps on a handle | Shift while dragging a padding or gap handle steps by the big nudge | **HAVE**: padding and gap (`autolayout-logic.js` handleSteps) | - | - |
| Click a padding area | Option+click a padding area sets the opposite sides; Option+Shift+click sets all | **HAVE**: with Option held a padding area is a handle; a click opens the field for those sides (`autolayout.js`). [Evidence](evidence/moving.md) | - | - |
| All padding from one field | Cmd+click a padding field, then type | **HAVE**: `InspectorLayout.swift` allSides | - | - |
| Alignment box keys | Arrows set alignment, W/A/S/D align to an edge, B baseline, X gap Auto | **HAVE**: `InspectorLayout.swift` alignment box keys | - | - |
| Gap Auto, wrap | Gap can be Auto (between, around, evenly); flows can wrap | **HAVE**: `InspectorLayout.swift` settings popover | - | - |
| Ignore auto layout | A child can opt out of the flow from the right sidebar | **HAVE**: `InspectorLayout.swift` (layoutPosition) | - | - |
| Reorder by arrow keys | Arrow keys move a flow child through the order | **HAVE**: `autolayout.js` (burst is one undo step) | - | - |
| Reorder by dragging | Drag a flow child; siblings slide; a line shows the slot | **HAVE**: `autolayout.js`; the drag draws only the frame and the layer at the pointer, checked frame by frame (docs/evidence/autolayout-drag.md) | - | - |
| Swap two children by Shift+drag | Shift+drag in auto layout swaps two layers | **SKIP**: Shift already locks the drag axis; swap is Cmd in a smart selection | - | - |
| Text baseline alignment | Toggle with B in the alignment box | **HAVE**: `InspectorLayout.swift` | - | - |

## Smart selection and arranging

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Spacing handles | With evenly spaced layers selected, pink handles between them change the spacing by dragging | **HAVE**: `src/page/smart.js` (three layers or more; rows, columns, 2D). [Evidence](evidence/moving.md) | - | - |
| Reorder in a smart selection | Click the pink knob in a layer's centre to mark it, drag to a new slot; a blue line shows where | **HAVE**: `smart.js` | - | - |
| Swap in a smart selection | Hold Cmd while dragging a marked layer to swap places | **HAVE**: `smart.js` | - | - |
| Mark several | Shift+click knobs marks more; double-click marks all; Cmd+D duplicates marked layers into the list | **HAVE**: `smart.js`; the double-click is on a ring, Delete closes the gap too | - | - |
| Spacing fields | Horizontal and vertical "space between" fields in the right sidebar for a smart selection | **HAVE**: `Inspector.swift` Spacing (`smart.js` smartGap) | - | - |
| Tidy up | Arranges a selection into an evenly spaced row or grid aligned to its top-left. Key: Control+Option+T | **HAVE**: `smart.js` tidyUp, Arrange > Tidy Up | - | - |
| Align | Option+W / A / S / D top, left, bottom, right; Option+H / V centres | **HAVE**: `shortcuts.js` align, Arrange menu | - | - |
| Align to the parent | Shift+click an align button aligns several layers to their parent frame | **HAVE**: Shift held on an Arrange align item (Canvas has no align buttons) aligns several layers to their parent (`shortcuts.js`, `main.swift`) | - | - |
| Distribute | Distribute horizontal / vertical spacing, outer layers fixed. Key: Control+Option+H / V | **HAVE**, key differs: Option+Shift+H / V (`shortcuts.js`) | P3 | S |

## Layers panel

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Range and toggle | Shift-click a range, Cmd-click one layer in or out | **HAVE**: `apps/macos/Layers.swift`, `LayersLogic.swift` | - | - |
| Rename in place | Double-click a layer name; double-click a frame's name on the canvas | **HAVE**: `Layers.swift`, `server.ts` renameBoard | - | - |
| Batch rename | Cmd+R with several layers opens Rename Layers: Rename to, Current name, Number up or down with a start value, Match and replace, regex tokens ($&, $1, $n, $nnn, $NNN), a preview | **HAVE**: Rename Layers sheet, `apps/macos/Layers.swift` BatchRenameLayer, `LayersLogic.swift` BatchRename ($&, $1, $`, $', $n, $nn, $N, $NN, start value, Match as a pattern or text, preview), one undo step | - | - |
| Tab to the next name | Tab while renaming moves to the next layer's name | **HAVE**: `Layers.swift` (Tab, Shift+Tab) | - | - |
| Hide and show | Eye icon, or Shift+Cmd+H | **HAVE**: `Layers.swift` eye, `shortcuts.js` toggleHidden | - | - |
| Lock | Shift+Cmd+L; a lock icon per row; a locked frame locks its children; locked layers ignore canvas clicks but stay selectable in the panel | **HAVE**: `locked` in the file format (schema, `set_node_props`), Object > Lock/Unlock Selection, `Layers.swift` padlock, `engine/src/hit.rs`, `server.ts` pick, `structure.js` marquee | - | - |
| Lock many at once | Click the lock control and drag across rows | **HAVE**: `Layers.swift` lockDragged, one undo step | - | - |
| Open everything inside | Option-click a triangle | **HAVE**: `Layers.swift`, `LayersLogic.swift` | - | - |
| Collapse all | Option+L collapses every open row | **HAVE**: Option+L, Object > Collapse Layers, `Layers.swift` collapseAll | - | - |
| Drag to reorder or reparent | Drag rows; a line or ring shows the drop | **HAVE**: `Layers.swift` LayerDrop | - | - |
| Hover a row | The layer gets an outline on the canvas | **HAVE**: `Layers.swift` hover | - | - |
| Show the panel by key | Option+1 Layers, Option+2 Assets | **SKIP**: Canvas's left panel has its own sections; Cmd+\ hides all panels | - | - |

## Inspector fields

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Step a value | Up/Down change by 1, Shift by 10 | **HAVE**: `apps/macos/DesignSystem/NumericInput.swift` (Option by 0.1) | - | - |
| Math in fields | +, -, *, /, ^ and parentheses. Appending to the number keeps it ("10*2"); typing over it replaces it | **HAVE**: + - * / ^ and parentheses, leading +8, *2 or ^2 apply to the current value (`ShellLogic.swift` NumericExpr) | - | - |
| Mixed values | Several layers with different values show "Mixed"; "Mixed+100" adds 100 to each | **HAVE**: `Inspector.swift` placeholder, `relativeEach` | - | - |
| Scrub | Hold Option over any field's label or input and drag; moving the pointer up or down changes the speed (2x, 1x, 1/2, 1/4) | **HAVE**: Option over a field's label or input, then drag (`DesignSystem/NumericInput.swift` OptionScrub): up 2x, near 1x, down 1/2 then 1/4 (`ScrubSpeed`); the label icon still scrubs without Option | - | - |
| Commit and move on | Return commits, Tab goes to the next field | **HAVE**: fields commit on Return, Tab or focus loss | - | - |
| Corner radius knob | Drag the knob at a corner; Option drags one corner (rectangles) | **HAVE**: `src/page/radius.js` | - | - |
| Independent corners | A toggle opens four corner fields; each takes a number variable | **HAVE**: `apps/macos/InspectorPaint.swift` | - | - |
| Corner smoothing | A slider, or iOS for 60% | **HAVE**: `cornerSmoothing` on frames and rectangles, the iOS button and a % field under the corner fields (`PaintEditor.swift`); the engine draws the squircle (`paint.rs` smooth_path), the DOM renderer a circular corner | - | - |
| Opacity by digits | 1 to 9 set 10% to 90%, 0 sets 100% | **HAVE**: `shortcuts.js` opacityKey (two quick digits make a percentage) | - | - |

## Fills, strokes, effects

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Paint rows | + adds, - removes, the eye hides, rows reorder by dragging | **HAVE**: `InspectorPaint.swift` | - | - |
| Selection colors | With mixed fills selected, a Selection colors section lists each colour once (grouped by variable, style, plain) and edits all its uses | **HAVE**: `PaintEditor.swift` SelectionColorsSection, `src/selection-colors.ts` (variables first, then by use; one write, one undo step) | - | - |
| Eyedropper in the picker | The picker's eyedropper samples a colour from the canvas | **HAVE**: `DesignSystem/ColorPicker.swift` (NSColorSampler) | - | - |
| Eyedropper by key | I (or Control+C) picks a colour for the selection's fill | **HAVE**: `shortcuts.js` I and Control+C, the app samples with NSColorSampler (`PaintEditor.swift` eyedropFill) | - | - |
| Colour notation | Switch between RGB, HEX, CSS, HSL, HSB | **HAVE**: Hex, RGB, HSL, OKLCH fields; any CSS colour pastes in (`ColorPicker.swift`) | - | - |
| File colours | The picker lists colours used in the file and libraries | **HAVE**: `ColorPicker.swift` document colours | - | - |
| Hex shorthand | "F" is #FFFFFF, "AB" is #ABABAB | **HAVE**: `PaintLogic.swift` shorthandHex | - | - |
| Lighter or darker hex | Shift+Up/Down in the hex field | **HAVE**: Shift+Up/Down 10% lightness, Up/Down 1% (`InspectorPaint.swift` ColorAlphaField, `PaintLogic.lighter`) | - | - |
| Gradients, image fills, blend modes | Fill type menu (solid, gradient, image), gradient stops, a blend mode per paint | **HAVE**: "+" type menu and the paint popover with type tabs (`PaintEditor.swift`): gradient stops, type, angle, flip; image and shader editors; blend mode per paint and per layer (engine and HTML). Gradient handles live in the popover, not on the canvas; no diamond gradient (the engine has none) | - | - |
| Contrast checker | The picker shows the contrast against what is behind | **HAVE**: `DesignSystem/ColorPicker.swift` ContrastLine (WCAG ratio and APCA Lc against the colour behind the node) | - | - |
| Copy and paste properties | Option+Cmd+C / Option+Cmd+V | **HAVE**: `shortcuts.js` copyProps / pasteProps, Edit menu | - | - |
| Copy one paint | Select a fill, stroke or effect row, Cmd+C, then Cmd+V on another layer's row | **HAVE**: click left of a fill, stroke or effect row's swatch to pick the row (grey); Cmd+C copies that paint, Cmd+V on a picked row replaces it, with no row picked it goes on top of its list; Cmd+X, Delete and Esc on a picked row; the canvas keeps Cmd+C / Cmd+V otherwise (`PaintEditor.swift` PaintRowSelection, `main.swift` StructureActions); right-click Copy Fill / Paste Fill too ([evidence](evidence/gaps.md)) | - | - |
| Remove or swap paints by key | Option+/ removes fill, Shift+/ removes stroke, Shift+X swaps fill and stroke | **HAVE**: `shortcuts.js` Option+/, Shift+/, Shift+X (`shortcuts-logic.js` removePaintWrite, swapPaintWrite) | - | - |
| Strokes | Inside, center, outside; weight; per side | **HAVE**: `InspectorPaint.swift` | - | - |
| Effects | Drop shadow, inner shadow, layer blur, background blur, each with an eye | **HAVE**: `InspectorPaint.swift` | - | - |

## Text

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Start editing | Double-click a text layer, or select it and press Enter | **HAVE**: `src/page/text-edit.js` (Enter selects all the text) | - | - |
| Stop editing | Esc ends the edit and leaves the layer selected | **HAVE**: `text-edit.js` (also Cmd+Return) | - | - |
| Edit the next text layer | While editing, a click on another text layer edits it at once | **HAVE**: `src/page/text-edit.js` nextEdit (a plain click on another text layer edits it, the caret at the click) | - | - |
| Multi-edit text | Select several text layers, press Return (or Multi-edit text) and type: all update | **HAVE**: Return with several text layers selected; the first selected is edited, the rest take the text; one undo step (`text-edit.js`, `/api/text` also) | - | - |
| Font size | Shift+Cmd+&lt; / &gt; | **HAVE**: Shift+Cmd+. / , (`shortcuts.js`) | - | - |
| Letter spacing | Option+&lt; / &gt; | **HAVE**: 0.1 px a press, each layer from its own value (`shortcuts-logic.js` typeStep); on the selected letters while editing | - | - |
| Line height | Option+Shift+&lt; / &gt; | **HAVE**: 1 px a press; Auto becomes the px it draws at (`typeStep`) | - | - |
| Font weight | Option+Cmd+&lt; / &gt; | **HAVE**: to the next hundred, 100 to 900 (`typeStep`); on the selected letters while editing | - | - |
| Bold, italic, underline, strikethrough | Cmd+B, Cmd+I, Cmd+U, Shift+Cmd+X | **HAVE**: `shortcuts.js` (whole layers); while editing, on the selected letters (`text-edit.js` styleStep) | - | - |
| Style part of a text | Select a word while editing and change its weight, colour or size | **HAVE**: styled ranges (`spans`, `src/page/text-spans.js`): style keys and the inspector style the selected letters; the inspector reads Mixed; engine, DOM and SVG draw them | - | - |
| Text align | Option+Cmd+L / T / R / J | **HAVE**: `shortcuts.js` | - | - |
| Vertical align | Top, middle, bottom for fixed-size text | **HAVE**: `Inspector.swift` Typography (textAlignVertical) | - | - |
| Lists | Shift+Cmd+7 numbered, Shift+Cmd+8 bulleted; Tab nests (five levels); "- " / "1. " typed start a list; bullets the same at every level, numbers turn 1. a. i. by level | **HAVE**: `lists` per paragraph (`src/page/text-paras.js`), engine markers and hanging indent, Typography > List style, Tab / Shift+Tab (Shift+Tab is Canvas's own addition); List spacing, Hanging lists, each marker in its item's first letter's colour, Backspace keeps the indent when it takes the marker ([evidence](evidence/gaps.md)); Cmd+] / Control+] not taken (Cmd+] is Bring Forward) | - | - |
| Link | Cmd+K on selected text | **SKIP**: Cmd+K is Quick Actions in Canvas | - | - |
| Resizing mode | Auto width, auto height, fixed size in the Layout section | **HAVE**: `InspectorLayout.swift` textSizing (textGrowth) | - | - |
| Truncate and max lines | Truncate text with an ellipsis after N lines | **HAVE**: `textTruncation`, `maxLines`; Typography > Truncate text and Max lines; engine ellipsis (`engine/src/text.rs` finish_text) | - | - |
| Paragraph settings | Paragraph spacing, indent, hanging quotes and lists, letter case | **HAVE**: `paragraphSpacing`, `paragraphIndent` (left-aligned text only), `letterCase` (Original, Uppercase, Lowercase, Title case, Small caps from the font's smcp), `hangingPunctuation` (an opening quote hangs outside the box) in Typography, drawn by the engine, the DOM renderer, SVG export and the editor ([evidence](evidence/gaps.md)); letter case is per layer, not per range | - | - |
| Paste and match style | Option+Shift+Cmd+V | **HAVE** in effect: text paste inside an edit is always plain (`text-edit.js`) | - | - |
| Find and replace | Cmd+F finds text on the page and replaces it | **HAVE**: Cmd+F (Edit > Find and Replace): every page, Match case, Whole words, Replace, Replace all, one undo step each (`src/page/find-replace.js`, `/api/replace`) | - | - |

## Components and instances

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Create component | Option+Cmd+K | **HAVE**: `shortcuts.js`, Object menu | - | - |
| Detach instance | Option+Cmd+B | **HAVE**: `shortcuts.js`, Object menu | - | - |
| Go to main component | A button on an instance | **HAVE**: `Inspector.swift` Component section | - | - |
| Select all instances | From the main component | **HAVE**: `Inspector.swift`, Cmd+K | - | - |
| Reset changes | Reset the whole instance, or one property | **HAVE**: Reset all changes, and each override row in the Component section resets one (its arrow or right-click; `Inspector.swift` OverrideRow, `src/overrides.ts` keys), and a right-click on an overridden Fill, Stroke, Effects, Appearance or Typography field offers Reset <property> (`InspectorPaint.swift` OverrideResetMenu); MCP `reset_overrides` | - | - |
| Swap instance | Pick another component from the instance menu, or Option+drag a component from Assets onto an instance; text edits carry over when layer names match | **HAVE**: the component name in the Component section is a picker, and the canvas menu has Swap instance (`Inspector.swift` SwapPicker); overrides carry over when the layer names path and type match, one undo step (`src/overrides.ts` applySwap); MCP `swap_instance`; a nested instance too (an override setting `ref` in the outer instance's `descendants`); Components panel rows drag onto the canvas as instances, Option+drag onto an instance swaps it (`src/page/drops.js`) ([evidence](evidence/gaps.md)) | - | - |
| Push changes to main | Push an instance's overrides to its main component (same file) | **HAVE**: Push changes to main in the Component section and the canvas menu (`src/overrides.ts` applyPush, one undo step); MCP `push_overrides` | - | - |
| Corner limits in instances | An instance's single corner cannot be changed | **HAVE**, stricter: inside an instance only overrides are editable (`Inspector.swift`) | - | - |

## Copy, paste, duplicate

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Paste into the selected frame | Keeps its x/y relative to the frame it came from; centred on an axis that does not fit | **HAVE**: `structure.js` pastePlace (the centring on an axis that does not fit since 2026-11-16) | - | - |
| Paste here | Right-click > Paste here at the pointer | **HAVE**: Edit and right-click menus, `structure.js` | - | - |
| Paste over selection | Shift+Cmd+V places the copy at the original's x/y | **HAVE** as Paste in Place, Shift+Cmd+V | - | - |
| Paste to replace | Shift+Cmd+R swaps the selection for the clipboard; the new layer takes the old one's place | **HAVE**: Edit > Paste to Replace and the right-click menu, `structure.ts` replaceNodes (same parent, index and x/y; one undo) | - | - |
| Paste into several frames | Select several frames, Cmd+V: one copy into each; several copied layers repeat across them | **HAVE**: `structure.js` frameTargets, `structure.ts` pasteMany (one undo) | - | - |
| Copy as PNG | Shift+Cmd+C copies the selection as a 2x PNG for other apps | **HAVE**: Edit > Copy as PNG, `src/copy-as.ts`, `src/page/copy-as.js` | - | - |
| Copy as SVG | Right-click > Copy/Paste as > Copy as SVG | **HAVE**: right-click > Copy as > Copy as SVG | - | - |
| Copy as code | Right-click > Copy/Paste as > Copy as code: CSS, iOS or Android | **HAVE**: Copy as CSS and SwiftUI (`src/codegen.ts`); no Android | - | - |
| Copy link | Cmd+L copies a link to the selection | **HAVE**: Edit > Copy Link, `src/page/link.js`; canvas:// links open in the app and resolve in MCP | - | - |
| Paste across pages and files, cards | Copied layers paste on another page or in another file | **HAVE**: layers and cards, across pages, tabs and files (docs/evidence/copy-paste.md) | - | - |
| Paste plain text | Text from another app pastes as a new text layer | **HAVE**: `structure.js` textLayer (Inter 14, its tracking; in the selected frame or the middle of the view); Canvas's own copy still wins | - | - |

## Images

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Paste an image | Cmd+V on empty canvas makes a rectangle with the image as its fill; images over 4096 px scale down | **HAVE**: `apps/macos/main.swift` pastedImageCommand, `src/page/drops.js` (in the middle of the view, or in the selected frame) | - | - |
| Drop image files | Drag files from Finder onto the canvas | **HAVE**: `src/page/drops.js`, `src/images.ts` (layers side by side inside the frame under the pointer, files copied into `media/`) | - | - |
| Image or shader onto a layer | Drop an image on a layer to make it the fill | **HAVE**: a drop of a shader tile (Option: a card), a Cmd-drop of an image file, or a Cmd-drag of a shader card on the canvas, outlines the layer and makes it the fill (`src/page/drops.js`, engine shader fills) | - | - |
| Place image | Shift+Cmd+K opens a file picker; several images place one per click | **HAVE**, without the clicks: File > Place Image (Shift+Cmd+K) places the chosen images side by side in the middle of the view or in the selected frame (`drops.js` placeImages; Canvas has no placing tool) | - | - |
| Replace an image fill | Select the area left of the fill swatch, then Cmd+V | **HAVE**: Choose image... in the image fill's popover; click left of the swatch to pick the row, Cmd+V with a picture replaces the image, keeping mode, crop and adjustments (`PaintLogic.swift` withImageURL) ([evidence](evidence/gaps.md)) | - | - |
| Fill modes | Fill, Fit, Crop, Tile; the mode holds when the layer is resized | **HAVE**: Fill, Fit, Crop, Tile in the image popover (`PaintEditor.swift`), engine `image_places`, HTML renderer; Crop is fractions of the layer so it holds on resize | - | - |
| Crop | Double-click the image (or Crop image, or the Crop mode); Cmd while resizing crops | **HAVE**: double-click a selected image layer, or Crop on canvas in its popover (`src/page/image-crop.js`): drag to move, corners scale with the aspect kept, Return/Esc/click outside writes Crop. Cmd while resizing is not there | - | - |
| Rotate the fill | Rotate 90° turns the image inside the layer | **HAVE**: Rotate 90° in the image popover (`rotation` on the fill), engine and HTML renderer | - | - |
| Adjustments | Exposure, contrast, saturation, temperature, tint, highlights, shadows | **HAVE**: exposure, contrast, saturation, temperature, tint (`src/page/image-adjust.js`, one colour matrix); highlights and shadows are not there | - | - |
| Use as mask | Control+Cmd+M | **HAVE**: Control+Cmd+M toggles `mask`; the engine cuts the layers above it to its alpha (`paint.rs` paint_kids), the HTML renderer clips to its shape in free frames | - | - |

## Zoom and navigation

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Pan | Hold Space and drag | **HAVE**: `server.ts` hand mode | - | - |
| Zoom with the pointer | Cmd+scroll, pinch | **HAVE**: `server.ts` wheel | - | - |
| Zoom in and out by key | Shift+ + / Shift+ -, and Cmd+ + / Cmd+ - | **HAVE**: Shift+= / Shift+- too (`src/page/navigate.js`) | - | - |
| Fit and 100% | Shift+1 fit all, Shift+2 the selection, Shift+0 (or Cmd+0) 100% | **HAVE**: `shortcuts-logic.js` zoomKey, View menu | - | - |
| Next and previous frame | N / Shift+N | **HAVE**: `shortcuts.js` stepBoard | - | - |
| Zoom tool | Hold Z and click to zoom in, Option+Z to zoom out | **HAVE**: Z+click, Z+Option+click (`navigate.js`) | - | - |
| Typed zoom | Type a percentage in the zoom field | **HAVE**: click the zoom percentage, type, Return (`ZoomField`) | - | - |
| Pan by keys | Arrows pan when nothing is selected, Shift pans faster | **HAVE**: `navigate.js` | - | - |
| Hide UI | Cmd+\ | **HAVE**: View menu | - | - |
| Pixel grid | Cmd+' shows the grid at 400% and up; Cmd+Shift+' toggles snap to pixel grid | **HAVE**: grid from 400%, Cmd+' (View > Pixel Grid); snap to the grid is still the Settings switch, no Shift+Cmd+' | - | - |
| Rulers and guides | Shift+R shows rulers; drag guides out of them | **HAVE**: guides saved per board (`navigate.js`, `metadata.canvasGuides`); no page-level guides | - | - |
| Layout guides | Control+G shows a frame's layout grid; grid, columns, rows with count, gutter, margin, offset, type stretch/left/center/right, colour | **HAVE**: inspector > Layout guide (+, type, eye, -), `metadata.canvasLayoutGuides`, drawn over the canvas (`src/page/navigate.js`), moves and resizes snap to them, Control+G and Shift+G, View > Layout Guides; no guide styles | - | - |
| Multiplayer cursors | Option+Cmd+\ | **SKIP**: one person per file; the agent cursor has its own switch in Settings > Agents | - | - |
| Pixel preview, outlines | Control+P pixel preview; outline view | **SKIP**: drawing precision views | - | - |

## Measurement

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Distance to another layer | Select, hold Option, hover another layer: red lines and the distances | **HAVE**: `shortcuts.js` paintMeasure | - | - |
| Distance to a nested layer | Cmd+Option and hover a layer inside a frame or group | **HAVE** in effect: Option alone measures to the deepest layer under the pointer | - | - |
| Distance to the parent | Option while hovering the selection itself | **HAVE**: `shortcuts.js` (parent when the pointer is over the selection) | - | - |
| Size label | W x H under the selection | **HAVE**: `server.ts` #seldim | - | - |
| Bounds, not ink | Distances go to bounding boxes, text to its box, not the baseline | **HAVE**: measures world rects | - | - |

## Export

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Export PNG and SVG | Export the selection at a scale | **HAVE**: right-click Export as PNG (1x, 2x, 3x, store presets) and SVG (`src/export.ts`) | - | - |
| Export by key | Shift+Cmd+E exports every selection with export settings | **HAVE**: File > Export (`Library.swift` exportSelectionWithSettings); a folder panel, not a list of files | - | - |
| Export settings per layer | An Export section stores scale, suffix and format on the layer; bulk export on the page | **HAVE**: the inspector's Export section (`InspectorExport.swift`, `metadata.canvasExports`) | - | - |
| More formats | JPG and PDF beside PNG and SVG | **HAVE**: JPG, WebP, PDF (`src/export.ts`) | - | - |

## Feedback and multi-select editing

| Behaviour | Rule | Canvas | Priority | Size |
|---|---|---|---|---|
| Edit several layers | Any field changes every selected layer; differing values read Mixed | **HAVE**: `Inspector.swift`, `InspectorLayout.swift` | - | - |
| Relative edit on Mixed | "Mixed+100", Up/Down on a Mixed field change each layer from its own value | **HAVE**: `relativeEach` | - | - |
| Confirm a clipboard action | A toast after Copy properties, Copy as PNG, Copy link | **HAVE**: toasts for Copy Link, Repeat, refused edits (`flash`, `tell`) | - | - |
| Say why nothing happened | "No matching layers to select on page" | **HAVE**, mostly: Canvas toasts when cards are left out of an action and when auto layout keeps layers in place (`structure.js`, `shortcuts.js`) | - | - |

## Top 20 to build next

Ranked by how often a designer hits it and how broken its absence feels. P1 first.

1. **Space held mid-drag keeps the parent** (P1, S). Space while dragging stops the layer leaving its frame or nesting into another. Today Space turns on hand mode and the drop reparents.
2. **Paste an image from the clipboard** (P1, M). Cmd+V with a screenshot or copied image makes an image-filled rectangle, scaled down past 4096 px. **Done** (docs/evidence/drops.md).
3. **Click another text layer while editing** (P1, S). The click starts editing that layer instead of only ending the current edit.
4. **Copy as PNG** (P1, M). Shift+Cmd+C puts a 2x PNG of the selection on the pasteboard.
5. **Lock layers** (P2, M). Shift+Cmd+L and a lock per row; locked layers ignore canvas clicks, stay selectable in the panel, and lock their children.
6. **Paste to replace** (P2, S). Shift+Cmd+R swaps the selection for the clipboard in the same place and parent. **Done** (docs/evidence/paste.md).
7. **Control bypasses snapping** (P2, S). Hold Control during a drag to skip snapping. **Done**: Control only, Cmd no longer bypasses.
8. **Smart selection** (P2, L). Pink spacing handles between evenly spaced layers, a centre knob to drag a layer to a new slot, Cmd while dragging to swap.
9. **Tidy up** (P2, S). Control+Option+T lays the selection out as an evenly spaced row or grid from its top-left.
10. **Select matching layers** (P2, S). Option+Cmd+A selects layers with the same name in the other boards.
11. **Type keys** (P2, S). Option+&lt; / &gt; letter spacing, Option+Shift+&lt; / &gt; line height, Option+Cmd+&lt; / &gt; font weight.
12. **Export by key** (P2, S). Shift+Cmd+E opens the export for the selection.
13. **Copy as SVG and Copy as CSS** (P2, M). Right-click > Copy as puts SVG or CSS for the selection on the pasteboard.
15. **Aspect ratio lock** (P2, S). A lock beside W and H; with it on, Control frees one drag. **Done** (docs/evidence/components-inspector.md).
14. **Image fill modes and crop** (P2, M). Fill, Fit, Crop, Tile on an image fill; double-click an image to crop it. **Done** (docs/evidence/fills.md).
16. **Right-click > Select layer** (P2, M). A submenu of every layer under the pointer.
17. **Swap instance** (P2, M). Pick another component for an instance; text overrides carry over when layer names match. **Done** (docs/evidence/components-inspector.md).
18. **Selection colors** (P2, M). With several layers selected, each colour in use listed once and edited everywhere at once. **Done** (docs/evidence/fills.md).
19. **I opens the eyedropper** (P2, S). Press I with a layer selected, click a colour on the canvas, and it becomes the fill. **Done** (docs/evidence/fills.md).
20. **Padding drag modifiers** (P2, S). Option+Shift drags all four sides, Shift alone steps by the big nudge.

## Counts

Rows per status in the tables above (183 rows): HAVE 177, SKIP 6. No PARTIAL or MISSING rows are left.
