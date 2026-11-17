# Canvas QA handoff · 15 November 2026

Claude's last source change was `0390bd3`; `109deb2` rebuilt the macOS app. Round 4's code review fixes landed. The broad interaction pass stopped when Claude approached its usage limit, so there is no clean round 4 report.

Resume in the native app on a scratch copy:

1. Drag a multi-selection across boards so layers land in different frames or on empty canvas. One undo should restore the whole move. Repeat with Option-drag, then undo, redo, and reopen the document.
2. Resize a group containing a 45° layer. The box should keep its ratio. Rotate a group containing auto-height text or a Hug frame twice; both drags should work.
3. Rename, hide, and drag rows in the Layers panel. Reorder pages and move a board to another page.
4. Edit an instance override and reset it. Enter negative percentage letter spacing and check that Hug sizing, opacity, and hex fields display correctly.
5. Type and paste formatted text into a canvas note. Check lists, undo, and scrolling in a long note.

Claude checked the mixed X field and relative `+10` edits in the native app. Background input blocked parts of the Layers, Pages, notes, and inspector checks above.

Also check the `finish_work` sound by ear. The earlier pass confirmed the app acknowledged the command.

Two product choices remain. Deleting a page currently moves its boards to another page. Keep that behavior until the owner decides whether page deletion should delete boards too. The Layers panel has no lock toggle because the current file schema has no lock field; locking would need an explicit design for storage.

The file engine from an earlier standalone project (`0360756`) now lives in `src/doc/`, so a fresh checkout builds on its own. Agents add layers through Canvas MCP's `add_nodes`.

## Round 4 results (15 November, evening)

Checks 1 and 2 ran in headless Chrome on the engine renderer. Multi-board drags, Option-drag, the 10 px cross-board drag, undo, redo and reload all passed. The double rotation of a group with auto-height text and a Hug frame passed too.

The one bug it found is fixed. A group whose stored x/y was not its layers' top-left corner (a 45° layer at local 0,0) drew its selection box and handles from that corner, so part of the layer fell outside and the nw handle resized like a w edge. The engine now sizes a group's box from its layers (`engine/src/layout.rs`), and `add_nodes` refits the groups it writes. Checked in the app: the box hugs the turned layer, the nw corner resizes about the opposite corner keeping the ratio, and undo restores the file exactly.

Checks 3 to 5 still need a real mouse. The full suite passes, except for one test that kills the server mid-write on a timer, which fails now and then under load.
