#!/usr/bin/env python3
"""Builds design/chat-to-selection/chat-to-selection.canvas: the four states of talking to the selection.

Run once to create the file; after that the design lives in Canvas and is edited there.
SF Pro with Apple's tracking by size (sf-typography), Canvas's light chrome tokens (src/tokens.ts).
"""
import json, os, sys, itertools

ids = itertools.count(1)
PFX = ""   # the boards added after the file went live get their own id prefix, so they never take an id Canvas made
def nid(p): return f"{PFX}{p}{next(ids)}"

# Canvas light tokens
# Canvas chrome tokens (src/tokens.ts). The pricing card is the design being edited: it keeps its own colours.
THEMES = {
    "light": dict(BG="#F6F6F6", PANEL="#FFFFFF", FG="#18181B", MUTED="#71717A", MUTEDBG="#F4F4F5", SEL="#0766EB",
                  HAIR="#0000001A", SURFACE="#FFFFFF", LINE="#E4E4E7", DISABLED="#D4D4D8", PLACEHOLDER="#A1A1AA",
                  FOOT="#FAFAFA", BOARD="#ECECEE", TIPBG="#18181BE6",
                  ON_TINT="#3F6DB8", SYSBLUE="#007AFF", SEL_GREY="#0000000F"),  # secondary text on the accent tint: the tint's hue, darker, never grey
    "dark": dict(BG="#18181B", PANEL="#27272A", FG="#F4F4F5", MUTED="#A1A1AA", MUTEDBG="#3F3F46", SEL="#3B82F6",
                 HAIR="#FFFFFF1F", SURFACE="#27272A", LINE="#3F3F46", DISABLED="#52525B", PLACEHOLDER="#71717A",
                 FOOT="#202023", BOARD="#1E1E21", TIPBG="#3F3F46F2",
                 ON_TINT="#93B4F0", SYSBLUE="#0A84FF", SEL_GREY="#FFFFFF14"),
}
ROW_Y = 0
def use(theme, row_y):
    global ROW_Y
    globals().update(THEMES[theme]); ROW_Y = row_y
use("light", 0)
TRACK = {11: 0.06, 12: 0, 13: -0.08, 14: -0.15, 15: -0.23, 16: -0.31, 17: -0.43, 20: -0.45, 22: -0.26, 28: 0.38, 40: 0.37}
LEAD = {11: 13, 12: 16, 13: 18, 14: 19, 15: 20, 16: 21, 17: 22, 20: 25, 22: 28, 28: 34, 40: 48}

def text(s, size, weight="400", fill=None, w=None, **kw):
    fill = FG if fill is None else fill
    fam = "SF Pro Display" if size >= 20 else "SF Pro Text"
    n = {"type": "text", "id": nid("t"), "content": s, "fontFamily": fam, "fontSize": size, "fontWeight": weight,
         "letterSpacing": TRACK[size], "fill": fill,
         # One line (no width to wrap in): 100%, so the box is the type and centring lines it up with icons and
         # chips. Text that wraps keeps Apple's leading.
         "lineHeight": 1 if w is None else round(LEAD[size] / size, 3)}
    if w is not None: n.update({"width": w, "textGrowth": "fixed-width"})
    n.update(kw)
    return n

def frame(name, children, **kw):
    n = {"type": "frame", "id": nid("f"), "name": name, "children": children}
    n.update(kw)
    return n

def icon(name, size=14, fill=None, lift=0, **kw):
    """lift: raise an icon that sits beside text onto the capitals' centre. Single-line labels are set at 100% line
    height, which leaves the capitals' centre about 1 px above the box's centre at 11-16 pt."""
    fill = MUTED if fill is None else fill
    if lift:
        return frame("Icon", [icon(name, size, fill, **kw)], layout="vertical", padding=[0, 0, lift, 0])
    n = {"type": "icon", "id": nid("i"), "library": "lucide", "icon": name, "width": size, "height": size, "fill": fill}
    n.update(kw)
    return n

MAGIC = "sparkles.2"   # the maintainer's pick from the Magic icons board

def sparkle(size=14, fill=None, **kw):
    """The magic icon: SF Symbol sparkles.2, rendered into symbols/ per colour (the app draws the real symbol)."""
    fill = SEL if fill is None else fill
    colour = {"#0766EB": "blue", "#3B82F6": "darkblue", "#FFFFFF": "white", "#71717A": "muted", "#A1A1AA": "muteddark",
              "#18181B": "fg", "#F4F4F5": "fgdark", "#007AFF": "sysblue", "#0A84FF": "sysbluedark"}[fill]
    return frame("Sparkle", [], width=size, height=size,
                 fill={"type": "image", "url": f"symbols/{MAGIC}-{colour}.png", "mode": "contain"}, **kw)

def rect(x, y, w, h, **kw):
    n = {"type": "rectangle", "id": nid("r"), "x": x, "y": y, "width": w, "height": h}
    n.update(kw)
    return n

SHADOW = [{"type": "shadow", "offset": {"x": 0, "y": 1}, "blur": 2, "spread": 0, "color": "#0000000F"},
          {"type": "shadow", "offset": {"x": 0, "y": 12}, "blur": 32, "spread": -4, "color": "#00000024"}]
def lift_shadow():
    """Separation from layered shadows instead of a border: a contact shadow tight enough to outline the edge, a
    short soft one under it and a wide ambient one. Stronger in dark, where shadows read less."""
    dark = BG == "#18181B"
    return [{"type": "shadow", "offset": {"x": 0, "y": 0}, "blur": 0, "spread": 0.5, "color": "#0000000F" if not dark else "#00000099"},
            {"type": "shadow", "offset": {"x": 0, "y": 1}, "blur": 3, "spread": 0, "color": "#00000014" if not dark else "#00000066"},
            {"type": "shadow", "offset": {"x": 0, "y": 12}, "blur": 32, "spread": -6, "color": "#0000002E" if not dark else "#000000A6"}]

CARD_SHADOW_LOUD = [{"type": "shadow", "offset": {"x": 0, "y": 16}, "blur": 40, "spread": 0, "color": "#0F172A33"}]
CARD_SHADOW_CALM = [{"type": "shadow", "offset": {"x": 0, "y": 1}, "blur": 2, "spread": 0, "color": "#0F172A0D"},
                    {"type": "shadow", "offset": {"x": 0, "y": 8}, "blur": 24, "spread": -6, "color": "#0F172A1A"}]

CARD_FG, CARD_MUTED = "#18181B", "#71717A"

def feature(s, calm):
    return frame("Feature", [icon("check", 16, "#0766EB", lift=1), text(s, 15, w=None, fill=CARD_FG)], layout="horizontal", gap=10 if calm else 8,
                 alignItems="center")

def pricing_card(x, y, calm):
    pad, gap = (36, 16) if calm else (28, 12)
    price = frame("Price", [text("$12", 40, "700" if not calm else "600", fill=CARD_FG), frame("Per", [text("/ month", 15, fill=CARD_MUTED)], padding=[0, 0, 7, 0])],
                  layout="horizontal", gap=6, alignItems="end")
    btn = frame("Button", [text("Start free trial", 15, "600", fill="#FFFFFF")], layout="horizontal",
                justifyContent="center", alignItems="center", width="fill_container", height=44,
                cornerRadius=12, fill="#0766EB")
    kids = [text("Pro", 15, "600", fill=CARD_MUTED), price,
            text("Everything in Free, plus unlimited decks and offline mode.", 15, w="fill_container",
                 fill=CARD_MUTED if calm else CARD_FG),
            frame("Divider", [], width="fill_container", height=1, fill="#E4E4E7"),
            frame("Features", [feature("Unlimited decks", calm), feature("Offline mode", calm), feature("Shared classes", calm)],
                  layout="vertical", gap=10 if calm else 8),
            btn]
    w = 360
    return frame("Pricing card", kids, x=x, y=y, width=w, layout="vertical", gap=gap, padding=pad,
                 cornerRadius=20, fill="#FFFFFF", effect=CARD_SHADOW_CALM if calm else CARD_SHADOW_LOUD)

def selection(x, y, w, h):
    out = [rect(x - 1, y - 1, w + 2, h + 2, stroke=SEL, strokeWidth=1, name="Selection box")]
    for hx, hy in [(x - 5, y - 5), (x + w - 3, y - 5), (x - 5, y + h - 3), (x + w - 3, y + h - 3)]:
        out.append(rect(hx, hy, 8, 8, fill="#FFFFFF", stroke=SEL, strokeWidth=1, name="Handle"))
    badge = frame("Size", [text(f"{w} × {h}", 11, "500", fill="#FFFFFF")], layout="horizontal", justifyContent="center",
                  padding=[1, 0], width=72, cornerRadius=4, fill=SEL, x=x + w / 2 - 36, y=y + h + 8)
    out.append(badge)
    return out

def glass(active=False):
    """Liquid Glass for the spark: a translucent body over a background blur, a bright rim at the top, a soft
    inner shade at the bottom, a light drop shadow. Active glass is tinted with the accent."""
    dark = BG == "#18181B"
    # Grey, never the accent: active is the same glass, a little denser (pressed)
    body = ("#FFFFFF2E" if dark else "#FFFFFFB3") if active else ("#FFFFFF1F" if dark else "#FFFFFF8C")
    rim = "#FFFFFFB3" if not dark else "#FFFFFF59"
    return dict(fill=body, effect=[
        {"type": "background_blur", "radius": 16},
        {"type": "shadow", "shadowType": "inner", "offset": {"x": 0, "y": 1}, "blur": 1, "spread": 0, "color": rim},
        {"type": "shadow", "shadowType": "inner", "offset": {"x": 0, "y": -2}, "blur": 4, "spread": 0,
         "color": "#0000001A" if not dark else "#00000040"},
        {"type": "shadow", "offset": {"x": 0, "y": 1}, "blur": 2, "spread": 0, "color": "#00000014"},
        {"type": "shadow", "offset": {"x": 0, "y": 6}, "blur": 16, "spread": -2, "color": "#00000026" if not dark else "#00000066"}])

def spark(x, y, active=False):
    return frame("Spark button", [sparkle(16, FG)], x=x, y=y, width=28, height=28,
                 layout="horizontal", justifyContent="center", alignItems="center", cornerRadius=8, **glass(active))

def keycap(keys, on_dark=False, on_muted=False):
    """A shortcut in a tight chip: each key in its own cap, glyph centred in the cap, so arrows and symbols
    (which SF Pro draws at mid-cap height) never float above the words next to them."""
    def glyph(k):
        sym = {"↩": "return", "↑": "arrow.up", "↓": "arrow.down", "⌘": "command"}.get(k)
        if not sym:
            return text(k, 11, "500", fill="#FFFFFFD9" if on_dark else MUTED, textAlign="center")
        colour = "white" if on_dark else ("muteddark" if MUTED == "#A1A1AA" else "muted")
        # SF Symbols centre in the cap; the text glyphs sat off-centre (SF Pro draws them at mid-cap height).
        return frame(sym, [], width=10, height=10, opacity=0.85 if on_dark else 1,
                     fill={"type": "image", "url": f"symbols/{sym}-{colour}.png", "mode": "contain"})
    caps = [frame("Key", [glyph(k)],
                  layout="horizontal", justifyContent="center", alignItems="center", height=18,
                  padding=[0, 4], cornerRadius=4, fill="#FFFFFF26" if on_dark else PANEL if on_muted else MUTEDBG,
                  **({"effect": [{"type": "shadow", "offset": {"x": 0, "y": 0}, "blur": 0, "spread": 0.5, "color": "#0000000F"},
                                 {"type": "shadow", "offset": {"x": 0, "y": 1}, "blur": 1, "spread": 0, "color": "#0000001A"}]} if on_muted else {}),
                  **({"width": 18} if len(k) == 1 else {}))
            for k in keys]
    return frame("Shortcut", caps, layout="horizontal", gap=2, alignItems="center")

def hint(keys, label=None, on_muted=False):
    kids = [keycap(keys, on_muted=on_muted)] + ([text(label, 12, fill=MUTED)] if label else [])
    return frame("Hint", kids, layout="horizontal", gap=6, alignItems="center")

def popover(x, y, kids, w=360):
    """Dividers run edge to edge: the content between them sits in padded sections, the dividers don't."""
    out, run = [], []
    def flush(first, last):
        if run:
            out.append(frame("Section", list(run), layout="vertical", gap=12, width="fill_container",
                             padding=[14 if first else 12, 14, 14 if last else 12, 14]))
            run.clear()
    for k in kids:
        if k.get("name") == "Divider":
            flush(not out, False); out.append(k)
        else:
            run.append(k)
    flush(not out, True)
    return frame("Composer", out, x=x, y=y, width=w, layout="vertical", cornerRadius=16, clip=True,
                 fill=PANEL, effect=lift_shadow())

def chip():
    return frame("Context", [icon("square-dashed", 12, MUTED, lift=1), text("Pricing card", 12, "500", fill=FG),
                             text("9 layers", 12, fill=MUTED)],
                 layout="horizontal", gap=6, alignItems="center", padding=[4, 8], cornerRadius=8, fill=MUTEDBG)

def footer(right):
    return frame("Footer", [frame("Harness", [icon("terminal", 12, MUTED, lift=1), text("Claude Code", 12, "500", fill=MUTED),
                                               icon("chevron-down", 12, MUTED)], layout="horizontal", gap=4,
                                   alignItems="center"),
                            frame("Spacer", [], width="fill_container", height=1)] + right,
                 layout="horizontal", alignItems="center", gap=8, width="fill_container")

def send(enabled=True):
    return frame("Send", [icon("arrow-up", 14, "#FFFFFF")], width=28, height=28, layout="horizontal",
                 justifyContent="center", alignItems="center", cornerRadius=14, fill=SEL if enabled else DISABLED)

def step(s, state):
    ic = {"done": icon("check", 14, MUTED, lift=1), "now": icon("loader", 14, SEL, lift=1), "next": icon("circle", 14, DISABLED, lift=1)}[state]
    return frame("Step", [ic, text(s, 13, "500" if state == "now" else "400", fill=FG if state != "next" else MUTED)],
                 layout="horizontal", gap=8, alignItems="center")

def caption(title, body, x=None):
    return frame("Caption", [text(title, 17, "600"), text(body, 15, fill=MUTED, w=600)], x=CX if x is None else x, y=64, layout="vertical",
                 gap=6)

PROMPT = "Make it calmer: more air, a softer shadow, a quieter price."
CX, CY, CW, CH_LOUD, CH_CALM = 160, 180, 360, 345, 385  # measured in Canvas
SPARK_X = CX + CW + 1 + 8          # 8 past the selection box's right edge
POP_X = SPARK_X + 28 + 8           # the composer 8 past the spark
TIP_X = SPARK_X + 28 + 8

def board(name, x, kids, width=1000):
    return frame(name, kids, x=x, y=ROW_Y, width=width, height=660, layout="none", fill=BOARD, cornerRadius=0, clip=True)

def ring_spark(x, y, sweep):
    track = {"type": "ellipse", "id": nid("e"), "x": 0, "y": 0, "width": 28, "height": 28, "fill": "#00000014" if BG != "#18181B" else "#FFFFFF1F", "innerRadius": 0.86}
    arc = {"type": "ellipse", "id": nid("e"), "x": 0, "y": 0, "width": 28, "height": 28, "fill": FG + "99", "innerRadius": 0.86,
           "startAngle": 90, "sweepAngle": -sweep, "name": "Progress"}
    return frame("Spark, working", [frame("Face", [sparkle(14, FG)], x=4, y=4, width=20, height=20, layout="horizontal",
                                          justifyContent="center", alignItems="center", cornerRadius=10),
                                    track, arc],
                 x=x, y=y, width=28, height=28, layout="none", cornerRadius=14, **glass())

def dot_spark(x, y):
    return frame("Spark, has a thread", [spark(0, 0), {"type": "ellipse", "id": nid("e"), "x": 21, "y": -1, "width": 8, "height": 8,
                                                         "fill": FG, "stroke": "#FFFFFF" if BG != "#18181B" else "#18181B", "strokeWidth": 1.5, "name": "Thread dot"}],
                 x=x, y=y, width=30, height=30, layout="none")

def bubble(s):
    return frame("Prompt", [text(s, 13, w=308)], padding=[8, 12], cornerRadius=12, fill=MUTEDBG, width="fill_container")

def make(suffix):
    b1 = board("1. Select: the spark appears", 0, [
        caption("1. Select something", "A small spark sits on the selection's top-right corner. Click it or press ⌘↩ to ask about exactly what is selected. Nothing else on the canvas changes."),
        pricing_card(CX, CY, False), *selection(CX, CY, CW, CH_LOUD), spark(SPARK_X, CY - 1),
        frame("Tooltip", [text("Ask about this", 12, "500", fill="#FFFFFF"), keycap(["⌘", "↩"], on_dark=True)], alignItems="center",
              x=TIP_X, y=CY + 1, layout="horizontal", gap=8, padding=[4, 8], cornerRadius=6, fill=TIPBG),
    ])

    b2 = board("2. Ask: a composer on the selection", 1120, [
        caption("2. Ask", "The composer opens beside the selection, never over it. The chip says what the agent will see; the harness is your own Claude Code or Codex. Return sends."),
        pricing_card(CX, CY, False), *selection(CX, CY, CW, CH_LOUD), spark(SPARK_X, CY - 1, True),
        popover(POP_X, CY - 1, [chip(),
            frame("Field", [text(PROMPT + "▏", 15, w=332)], layout="vertical", gap=0),
            footer([keycap(["⌘", "↩"]), send()])]),
    ])

    b3 = board("3. Work: one quiet line while the canvas changes", 2240, [
        caption("3. Watch it work", "The canvas shows the work. The composer only says what it is doing right now, in one line, with Stop. The run is one step in your undo history."),
        pricing_card(CX, CY, True), rect(CX, CY, CW, CH_CALM, fill="#0766EB0F", cornerRadius=20, name="Gloss"),
        *selection(CX, CY, CW, CH_CALM), spark(SPARK_X, CY - 1, True),
        popover(POP_X, CY - 1, [chip(),
            text("Make it calmer: more air, a softer shadow, a quieter…", 13, fill=MUTED),
            frame("Now", [icon("loader", 14, SEL, lift=1), text("Softening the shadow", 13, "500"),
                          frame("Spacer", [], width="fill_container", height=1),
                          frame("Stop", [icon("square", 10, FG, lift=1), text("Stop", 12, "500")], layout="horizontal", gap=6,
                                alignItems="center", padding=[0, 10], height=28, cornerRadius=8, fill=MUTEDBG)],
                  layout="horizontal", gap=8, alignItems="center", width="fill_container")]),
    ])

    b4 = board("4. Done: keep it or undo it", 3360, [
        caption("4. Keep or undo", "One line says what changed. Keep closes the composer; Undo takes the whole run back in one step; a follow-up continues the conversation."),
        pricing_card(CX, CY, True), *selection(CX, CY, CW, CH_CALM), spark(SPARK_X, CY - 1, True),
        popover(POP_X, CY - 1, [chip(),
            frame("Summary", [icon("check", 14, SEL, lift=1), text("Changed 6 properties on 4 layers", 13, "500")],
                  layout="horizontal", gap=8, alignItems="center"),
            frame("Actions", [frame("Undo", [text("Undo", 13, "500"), keycap(["⌘", "Z"], on_muted=True)], layout="horizontal", gap=8,
                                    padding=[0, 12], height=32, cornerRadius=8, fill=MUTEDBG, alignItems="center"),
                              frame("Keep", [text("Keep", 13, "600", fill="#FFFFFF")], layout="horizontal", padding=[0, 16], height=32, alignItems="center",
                                    cornerRadius=8, fill=SEL)], layout="horizontal", gap=8),
            frame("Divider", [], width="fill_container", height=1, fill=LINE),
            frame("Follow-up", [text("Ask a follow-up", 13, fill=PLACEHOLDER), frame("Spacer", [], width="fill_container", height=1),
                                send(False)], layout="horizontal", alignItems="center", width="fill_container")]),
    ])

    b5 = board("5. Closed while working: the run goes on", 4480, [
        caption("5. Close it, it keeps going", "Escape closes the composer, not the run. The spark becomes a progress ring on the layer, then a dot when the run ends and the canvas glosses what changed."),
        pricing_card(CX, CY, True), rect(CX, CY, CW, CH_CALM, fill="#0766EB0F", cornerRadius=20, name="Gloss"),
        *selection(CX, CY, CW, CH_CALM), ring_spark(SPARK_X, CY - 1, 250),
        frame("Tooltip", [text("Softening the shadow", 12, "500", fill="#FFFFFF"), text("3 of 4", 12, fill="#FFFFFFA6")],
              x=TIP_X, y=CY + 1, layout="horizontal", gap=8, padding=[4, 8], cornerRadius=6, fill=TIPBG),
    ])

    b6 = board("6. Back later: the thread lives on the layer", 5600, [
        caption("6. Pick the thread back up", "A layer that has been asked about shows a dot on its spark. Select it again, open the spark, and the same conversation is there, so a follow-up knows what it means."),
        pricing_card(CX, CY, True), *selection(CX, CY, CW, CH_CALM), dot_spark(SPARK_X, CY - 1),
        popover(POP_X, CY - 1, [chip(),
            frame("Earlier", [text("Yesterday, 18:40", 12, fill=MUTED), bubble(PROMPT),
                              frame("Result", [icon("check", 14, SEL, lift=1), text("Changed 6 properties on 4 layers", 13, "500"),
                                               frame("Spacer", [], width="fill_container", height=1), text("Kept", 12, fill=MUTED)],
                                    layout="horizontal", gap=8, alignItems="center", width="fill_container")],
                  layout="vertical", gap=8, width="fill_container"),
            frame("Divider", [], width="fill_container", height=1, fill=LINE),
            frame("Field", [text("A bit less padding than that▏", 15, w=332)], layout="vertical"),
            footer([keycap(["⌘", "↩"]), send()])]),
    ])

    def recent(prompt, where, when, active=False, style="blue"):
        """A Recent asks row. Selected, either on the accent tint with Apple's system blue for its secondary text
        and icon ("blue"), or on a neutral grey with grey secondary text and a text-coloured icon ("grey")."""
        blue, grey = active and style == "blue", active and style == "grey"
        second = SYSBLUE if blue else MUTED
        return frame("Recent ask", [sparkle(14, SYSBLUE if blue else FG if grey else MUTED),
                                    frame("Text", [text(prompt, 13, "500"), text(where, 12, fill=second)], layout="vertical", gap=4,
                                          width="fill_container"),
                                    text(when, 12, fill=second)],
                     layout="horizontal", gap=10, alignItems="center", padding=[8, 10], cornerRadius=8,
                     fill=(SYSBLUE + "1A") if blue else SEL_GREY if grey else None, width="fill_container")

    def palette(x, style):
        return frame("Palette, " + style, [
            frame("Search", [icon("search", 14, MUTED, lift=1), text("recent", 15), frame("Spacer", [], width="fill_container", height=1),
                             keycap(["esc"])], layout="horizontal", gap=10, alignItems="center", padding=[12, 18],
                  width="fill_container"),
            frame("Divider", [], width="fill_container", height=1, fill=LINE),
            frame("Results", [frame("Header", [text("RECENT ASKS", 11, "600", fill=MUTED, letterSpacing=0.06)], padding=[4, 10, 8, 10]),
                              recent("Make it calmer: more air, a softer shadow", "Pricing card on Final", "18:40", True, style),
                              recent("Swap the hero copy for the Finnish course", "Hero on Proposal", "Yesterday"),
                              recent("Three takes on the empty state", "Empty state on Design System", "Mon"),
                              recent("Match the chart colours to the brand", "Platforms on PostHog", "12 Nov")],
                  layout="vertical", gap=2, padding=[10, 8], width="fill_container"),
            frame("Divider", [], width="fill_container", height=1, fill=LINE),
            frame("Keys", [hint(["↩"], "Open"), hint(["↑", "↓"], "Move"), hint(["esc"], "Close")], layout="horizontal", gap=16, alignItems="center",
                  padding=[10, 18], width="fill_container")],
              x=x, y=CY, width=560, layout="vertical", cornerRadius=14, fill=PANEL, effect=lift_shadow(), clip=True)

    b7 = board("7. Every thread in Cmd+K", 6720, [
        caption(x=220, title="7. Find any thread", body="Cmd+K, then Recent asks: every conversation in the file, newest first. Return flies to its layer and reopens the chat there."),
        palette(220, "grey"),
    ])



    out = [b1, b2, b3, b4, b5, b6, b7]
    for b in out: b["name"] += suffix
    return out

SYMBOLS = ("sparkles,sparkle,sparkles.2,sparkles.rectangle.stack,sparkle.magnifyingglass,sparkles.square.filled.on.square,"
           "wand.and.sparkles,wand.and.sparkles.inverse,wand.and.stars,wand.and.stars.inverse,wand.and.rays,wand.and.rays.inverse,"
           "apple.intelligence,text.badge.star,sparkle.text.clipboard,character.textbox.badge.sparkles,"
           "bubble.left.and.text.bubble.right,star.bubble,quote.bubble,brain,brain.head.profile,lightbulb.max,bolt.horizontal,"
           "moon.stars,staroflife,sun.max,circle.hexagongrid,atom,party.popper,theatermask.and.paintbrush,paintbrush.pointed,"
           "wand.and.outline").split(",")

def sym(name, size, color):
    """An SF Symbol rendered to symbols/<name>-<color>.png (medium weight), placed as an image."""
    return frame(name, [], width=size, height=size, fill={"type": "image", "url": f"symbols/{name}-{color}.png", "mode": "contain"})

def icon_tile(name, dark):
    note = "Apple Intelligence only" if name == "apple.intelligence" else None
    button = frame("In the spark", [sym(name, 16, "white")], width=28, height=28, layout="horizontal",
                   justifyContent="center", alignItems="center", cornerRadius=14, fill=SEL)
    kids = [frame("Big", [sym(name, 40, "darkblue" if dark else "blue")], width=56, height=56, layout="horizontal",
                  justifyContent="center", alignItems="center"),
            button, text(name.replace(".", ".\u200b"), 11, "500", fill=FG, w=136, textAlign="center")]
    if note: kids.append(text(note, 11, fill=MUTED, w=136, textAlign="center"))
    return frame("Icon", kids, width=136, layout="vertical", gap=8, alignItems="center")

def icons_board(x, dark):
    rows = [SYMBOLS[i:i + 8] for i in range(0, len(SYMBOLS), 8)]
    grid = frame("Grid", [frame("Row", [icon_tile(n, dark) for n in r], layout="horizontal", gap=16) for r in rows],
                 x=CX, y=CY, layout="vertical", gap=28)
    return frame("Magic icons" + (", dark" if dark else ""), [
        caption("Pick the magic icon", "Every SF Symbol that could mean ask the agent: large, and as it sits in the 28 px spark. Medium weight, the app's accent colour."),
        grid], x=x, y=ROW_Y, width=1520, height=900, layout="none", fill=BOARD, clip=True)

# ---------- composer variations (maintainer: smaller; try serif and mono) ----------
NY_TRACK = {11: 0.12, 12: 0.07, 13: 0.05, 14: 0.03, 15: 0, 16: -0.03, 17: -0.07}

def serif(s, size, weight="400", fill=None, italic=False, w=None):
    n = text(s, size if size in TRACK else 13, weight, fill, w)
    n.update({"fontFamily": "New York", "fontSize": size, "letterSpacing": NY_TRACK.get(size, 0)})
    if italic: n["fontStyle"] = "italic"
    return n

def mono(s, size, weight="400", fill=None):
    n = text(s, 12, weight, fill)
    n.update({"fontFamily": "SF Mono", "fontSize": size, "letterSpacing": 0})
    return n

def small_btn(label, primary=False, keys=None):
    kids = [text(label, 12, "600" if primary else "500", fill="#FFFFFF" if primary else FG)]
    if keys: kids.append(keycap(keys, on_muted=True))
    return frame(label, kids, layout="horizontal", gap=6, alignItems="center", height=26, padding=[0, 10], cornerRadius=7,
                 fill=SEL if primary else MUTEDBG)

def mini_send(neutral=False):
    return frame("Send", [icon("arrow-up", 12, FG if neutral else "#FFFFFF")], width=22, height=22, layout="horizontal",
                 justifyContent="center", alignItems="center", cornerRadius=11, fill=MUTEDBG if neutral else SEL)

def panel(kids, w=264, pad=10, gap=8, radius=12):
    return frame("Composer", kids, width=w, layout="vertical", gap=gap, padding=pad, cornerRadius=radius,
                 fill=PANEL, effect=lift_shadow())

def row(kids, gap=8):
    return frame("Row", kids, layout="horizontal", gap=gap, alignItems="center", width="fill_container")

SPACER = lambda: frame("Spacer", [], width="fill_container", height=1)

def chip_x(label, mono_font=True):
    """The selection as a removable chip inside the input (Stitch, Replit)."""
    t = mono(label, 11, "500", fill=FG) if mono_font else text(label, 12, "500", fill=FG)
    return frame("Context", [icon("square-dashed", 11, MUTED, lift=1), t, icon("x", 10, MUTED, lift=1)],
                 layout="horizontal", gap=5, alignItems="center", height=20, padding=[0, 6], cornerRadius=6, fill=MUTEDBG)

def harness_tag():
    return frame("Harness", [mono("claude", 11, fill=MUTED), icon("chevron-down", 10, MUTED, lift=1)], layout="horizontal", gap=3, alignItems="center")

def variant(style):
    """One composer style in its three states: ask, working, done. Sans (SF) for words, SF Mono for machine facts."""
    if style == "chip":            # after Stitch and Replit: the selection is a chip inside the input
        ask = panel([chip_x("pricing-card"), text("Make it calmer…", 13, fill=MUTED),
                     row([harness_tag(), SPACER(), mini_send()])])
        work = panel([chip_x("pricing-card"), row([icon("loader", 12, SEL, lift=1), text("Softening the shadow", 13, "500"), SPACER(),
                      mono("3/4", 11, fill=MUTED)]), row([harness_tag(), SPACER(), text("Stop", 12, "500", fill=MUTED)])])
        done = panel([chip_x("pricing-card"), row([icon("check", 12, SEL, lift=1), mono("6 changes", 11, fill=FG), SPACER(),
                      small_btn("Undo"), small_btn("Keep", True)])])
    elif style == "pill":          # after Gemini: one line
        def pill(kids):
            return frame("Pill", kids, layout="horizontal", gap=8, alignItems="center", height=36, padding=[0, 6, 0, 12],
                         cornerRadius=18, width=300, fill=PANEL, effect=lift_shadow())
        ask = pill([sparkle(14, SEL), text("Make it calmer…", 13, fill=MUTED), SPACER(), harness_tag(), mini_send()])
        work = pill([icon("loader", 14, SEL), text("Softening the shadow", 13, "500"), SPACER(), mono("3/4", 11, fill=MUTED),
                     text("Stop", 12, "500", fill=MUTED), frame("Pad", [], width=4, height=1)])
        done = pill([icon("check", 14, SEL), mono("6 changes", 11, fill=FG), SPACER(), small_btn("Undo"), small_btn("Keep", True)])
    elif style == "toolbar":       # after Base44: an action on the selection's own toolbar that grows into the input
        def bar(kids, w=None):
            return frame("Toolbar", kids, layout="horizontal", gap=4, alignItems="center", height=32, padding=[0, 4],
                         cornerRadius=10, fill=PANEL, effect=lift_shadow(), **({"width": w} if w else {}))
        def tool(name):
            return frame(name, [icon(name, 14, FG)], width=24, height=24, layout="horizontal", justifyContent="center",
                         alignItems="center", cornerRadius=6)
        ask = bar([tool("copy"), tool("trash-2"), frame("Div", [], width=1, height=16, fill=LINE),
                   frame("Ask", [sparkle(12, SEL), text("Make it calmer…", 13, fill=MUTED)], layout="horizontal", gap=6,
                         alignItems="center", padding=[0, 6], width=170), mini_send()], w=300)
        work = bar([icon("loader", 12, SEL), text("Softening the shadow", 12, "500"), SPACER(), mono("3/4", 11, fill=MUTED),
                    text("Stop", 12, "500", fill=MUTED), frame("Pad", [], width=4, height=1)], w=300)
        done = bar([icon("check", 12, SEL), mono("6 changes", 11), SPACER(), small_btn("Undo"), small_btn("Keep", True)], w=300)
    elif style == "docked":        # after Recraft and Visual Electric: docked at the bottom of the canvas
        def dock(kids):
            return frame("Dock", kids, width=300, layout="vertical", gap=8, padding=10, cornerRadius=14, fill=PANEL, effect=lift_shadow())
        ask = dock([text("Make it calmer…", 13, fill=MUTED),
                    row([chip_x("pricing-card"), SPACER(), harness_tag(), mini_send()])])
        work = dock([row([icon("loader", 12, SEL, lift=1), text("Softening the shadow", 13, "500"), SPACER(), mono("3/4", 11, fill=MUTED)]),
                     row([chip_x("pricing-card"), SPACER(), text("Stop", 12, "500", fill=MUTED)])])
        done = dock([row([icon("check", 12, SEL, lift=1), text("Calmer", 13, "600"), mono("6 changes", 11, fill=MUTED)]),
                     row([chip_x("pricing-card"), SPACER(), small_btn("Undo"), small_btn("Keep", True)])])
    elif style == "mono-status":   # a status strip in mono under a plain field
        ask = panel([text("Make it calmer…", 13, fill=MUTED), frame("Strip", [mono("pricing-card / 9 layers", 10, fill=MUTED), SPACER(),
                     mono("claude", 10, fill=MUTED), mini_send()], layout="horizontal", gap=8, alignItems="center", width="fill_container")])
        work = panel([text("Softening the shadow", 13, "500"), frame("Strip", [frame("Bar", [frame("Fill", [], width=112, height=2, fill=SEL)],
                      width=150, height=2, fill=LINE, layout="none"), SPACER(), mono("3/4", 10, fill=MUTED), mono("stop", 10, "500", fill=MUTED)],
                      layout="horizontal", gap=8, alignItems="center", width="fill_container")])
        done = panel([row([text("Calmer", 13, "600"), SPACER(), small_btn("Undo"), small_btn("Keep", True)]),
                      mono("+6 changes  4 layers  12 s", 10, fill=MUTED)])
    else:                          # "glass": the spark grows into a glass pill, mono facts
        def gl(kids):
            g = glass()
            return frame("Glass", kids, layout="horizontal", gap=8, alignItems="center", height=36, padding=[0, 6, 0, 10],
                         cornerRadius=18, width=300, **g)
        ask = gl([sparkle(14, FG), text("Make it calmer…", 13, fill=MUTED), SPACER(), mini_send(neutral=True)])
        work = gl([icon("loader", 14, FG), text("Softening the shadow", 13, "500"), SPACER(), mono("3/4", 11, fill=MUTED),
                   frame("Pad", [], width=4, height=1)])
        done = gl([icon("check", 14, FG), mono("6 changes", 11), SPACER(), small_btn("Undo"), small_btn("Keep", True)])
    return [ask, work, done]

VARIANTS = [("chip", "A. Chip in the input", "After Stitch and Replit: the selection sits in the field as a removable chip; the harness in mono."),
            ("pill", "B. One-line pill", "After Gemini: a single 36 pt line that changes in place."),
            ("toolbar", "C. On the selection's toolbar", "After Base44: ask from the layer's own toolbar, next to copy and delete."),
            ("docked", "D. Docked at the bottom", "After Recraft and Visual Electric: one spot for every ask, the selection as a chip."),
            ("mono-status", "E. Mono status strip", "A plain field with a quiet mono strip: place, harness, progress, time."),
            ("glass", "F. Glass pill (chosen)", "Picked 2026-11-16. The spark grows into a Liquid Glass pill; counts in mono; a mono chip when several layers are selected.")]

def variations_board(x, y):
    global ROW_Y
    cols = []
    for key, title, note in VARIANTS:
        states = variant(key)
        col = [text(title, 15, "600"), text(note, 12, fill=MUTED, w=300)]
        for label, st in zip(["Ask", "Working", "Done"], states):
            col += [text(label.upper(), 11, "600", fill=MUTED, letterSpacing=0.06), st]
        cols.append(frame(title, col, layout="vertical", gap=12, width=300))
    grid = frame("Variations", cols, layout="horizontal", gap=48, x=CX, y=CY)
    return frame("Composer variations", [caption("Composer variations", "Smaller and quieter, from Mobbin references (Stitch, Replit, Gemini, Base44, Recraft, Visual Electric). SF for words, SF Mono for machine facts. Pick a column, or mix rows."), grid],
                 x=x, y=y, width=CX * 2 + 6 * 300 + 5 * 48, height=900, layout="none", fill=BOARD, clip=True)


# ---------- chat variations (maintainer, 2026-11-16: the talk-to-selection chat, again, from Mobbin references) ----------
# Every variant: an opaque panel (the popover surface, layered shadows, no border, no glass), the 28 pt glass spark
# beside it unchanged, grey magic. Send and the harness mark sit on the last line's row or in a bottom toolbar, never
# centred against a growing field. Return sends, so no keycaps beside send.
def is_dark(): return BG == "#18181B"

def img(name, w, h=None, **kw):
    return frame(name, [], width=w, height=h or w, fill={"type": "image", "url": f"symbols/{name}.png", "mode": "contain"}, **kw)

def sf(name, size, role="muted"):
    """An SF Symbol (or harness mark) PNG from symbols/, in the theme's muted or text colour, or a fixed one."""
    col = {"muted": "muteddark" if is_dark() else "muted", "fg": "fgdark" if is_dark() else "fg"}.get(role, role)
    return img(f"{name}-{col}", size)

def box(kids, size, name="Box", **kw):
    """Centres a glyph in a square, so every control in a row has the same height."""
    return frame(name, kids, width=size, height=size, layout="horizontal", justifyContent="center", alignItems="center", **kw)

def mark(size=24, role="muted", harness="claude"):
    # The template PNG has its own margin: a 14 pt image draws a mark about 10 pt tall, the text's cap height.
    return box([sf(harness, 14, role)], size, name="Harness")

U1 = "Why is send button not aligned in these designs?"
R1 = "The field had a fixed width, so Send floated mid-row. It fills the row now, and Send sits on the last line."
U2 = "Do the same in the dark row"
R2 = "The dark composers match the light ones now."
TYPED = "Why is send button not aligned in these designs? It should sit on the last line with the Claude mark, never centred against the field."

def field_text(s, typed):
    return text(s, 13, fill=FG if typed else MUTED, w="fill_container", name="Field")

def send_btn(enabled=True, size=24, shape="circle"):
    """Neutral, never blue: text colour when there is something to send, the hover grey when there is not."""
    dark = is_dark()
    fill = FG if enabled else ("#FFFFFF1A" if dark else "#0000000F")
    arrow = ("arrow.up-fg" if dark else "arrow.up-white") if enabled else ("arrow.up-muteddark" if dark else "arrow.up-muted")
    return frame("Send", [img(arrow, 11)], width=size, height=size, layout="horizontal", justifyContent="center",
                 alignItems="center", cornerRadius=size / 2 if shape == "circle" else 7, fill=fill)

def undo_btn():
    return frame("Undo", [text("Undo", 12, "500")], layout="horizontal", alignItems="center", height=20, padding=[0, 8],
                 cornerRadius=10, fill="#FFFFFF1A" if is_dark() else "#0000000F")

def meta(mono_style=False):
    n = mono("2 CHANGES", 10, "500", fill=MUTED) if mono_style else text("2 changes", 12, fill=MUTED)
    return frame("Changes", [n, undo_btn()], layout="horizontal", gap=8, alignItems="center")

def exchange(you, reply, style="plain"):
    if style == "bubble":
        kids = [frame("You", [frame("Bubble", [text(you, 13, w="fit_content" if len(you) < 30 else 200)], padding=[7, 10],
                                    cornerRadius=12, fill=MUTEDBG)], layout="horizontal", justifyContent="end", width="fill_container"),
                text(reply, 13, w="fill_container"), meta()]
    elif style == "avatar":
        kids = [text(you, 13, "500", w="fill_container"),
                frame("Reply", [box([sf("claude", 14)], 18), text(reply, 13, w="fill_container")], layout="horizontal", gap=6,
                      width="fill_container"),
                frame("Indent", [meta()], padding=[0, 0, 0, 24])]
    else:
        kids = [text(you, 13, fill=MUTED, w="fill_container"), text(reply, 13, w="fill_container"), meta(style == "mono")]
    return frame("Exchange", kids, layout="vertical", gap=6, width="fill_container")

def thread(style="plain", pad=12):
    return frame("Thread", [exchange(U1, R1, style), exchange(U2, R2, style)], layout="vertical", gap=14,
                 width="fill_container", padding=[pad, pad, pad, pad])

def divider():
    return frame("Divider", [], width="fill_container", height=1, fill=LINE)

def card(kids, radius=16, **kw):
    kw.setdefault("layout", "vertical")
    return frame("Composer", kids, width=300, cornerRadius=radius, fill=PANEL, effect=lift_shadow(), clip=True, **kw)

def picker():
    """A model-picker label, as the references show it: the mark, the harness, a chevron. One height with send."""
    return frame("Harness", [sf("claude", 14), text("Claude", 12, "500", fill=MUTED), sf("chevron.down", 8)],
                 layout="horizontal", gap=4, alignItems="center", height=24)

def chat_variant(key):
    """Empty, a three-line prompt being typed, and a thread after two exchanges."""
    if key == "toolbar":       # Cursor, LangChain, Plane: text on top, a toolbar under it
        def inp(s, typed):
            return frame("Input", [field_text(s, typed), row([picker(), SPACER(), send_btn(typed)])], layout="vertical",
                         gap=10, padding=[12, 12, 10, 12], width="fill_container")
        return [card([inp("Ask about this", False)]), card([inp(TYPED, True)]),
                card([thread(), divider(), inp("Ask a follow-up", False)])]
    if key == "header":        # Ferndesk: a header that says what the agent sees, a footer with send
        def head():
            return frame("Header", [sf("square.dashed", 11), text("Pricing card", 12, "500"), SPACER(), mark(20)],
                         layout="horizontal", gap=6, alignItems="center", height=36, padding=[0, 10, 0, 12], width="fill_container")
        def inp(s, typed):
            return frame("Input", [field_text(s, typed), row([SPACER(), send_btn(typed, shape="square")])], layout="vertical",
                         gap=8, padding=[12, 10, 10, 12], width="fill_container")
        ex = lambda u, r: frame("Exchange", [exchange(u, r)], padding=12, width="fill_container")
        return [card([head(), divider(), inp("Ask about this", False)]), card([head(), divider(), inp(TYPED, True)]),
                card([head(), divider(), ex(U1, R1), divider(), ex(U2, R2), divider(), inp("Ask a follow-up", False)])]
    if key == "lastline":      # Tana, Manus: no toolbar; the mark and send end the last line
        def inp(s, typed):
            # The field's 18 pt lines get 1 pt above and below, so its last line is centred on the 20 pt controls.
            return frame("Input", [frame("Text", [field_text(s, typed)], padding=[1, 0], width="fill_container"),
                                   frame("Controls", [mark(20), send_btn(typed, 20)], layout="horizontal", gap=4, alignItems="center")],
                         layout="horizontal", gap=8, alignItems="end", padding=[10, 10, 10, 12], width="fill_container")
        return [card([inp("Ask about this", False)]), card([inp(TYPED, True)]),
                card([thread("avatar"), divider(), inp("Ask a follow-up", False)])]
    if key == "pill":          # Mistral, Grok: one line that opens into a card as she types
        def pill(s):
            return card([text(s, 13, fill=MUTED, name="Field"), SPACER(), mark(24), send_btn(False)], radius=18, layout="horizontal",
                        gap=4, alignItems="center", height=36, padding=[0, 6, 0, 14])
        typed = card([field_text(TYPED, True), row([SPACER(), mark(24), send_btn(True)], gap=4)], radius=18, gap=6,
                     padding=[10, 6, 6, 14])
        return [pill("Ask about this"), typed,
                frame("Stack", [card([thread("bubble")], radius=16), pill("Ask a follow-up")], layout="vertical", gap=8, width=300)]
    if key == "chip":          # Notion, Langdock: the selection as a chip on top of the field
        def chipx():
            return frame("Context", [sf("square.dashed", 10), text("Pricing card", 12, "500"), sf("xmark", 8)], layout="horizontal",
                         gap=5, alignItems="center", height=22, padding=[0, 7], cornerRadius=6, fill=MUTEDBG)
        def inp(s, typed):
            return frame("Input", [chipx(), field_text(s, typed),
                                   row([frame("Pick", [mark(24), sf("chevron.down", 8)], layout="horizontal", alignItems="center"), SPACER(), send_btn(typed)])],
                         layout="vertical", gap=10, padding=[12, 12, 10, 10], width="fill_container")
        return [card([inp("Ask about this", False)]), card([inp(TYPED, True)]),
                card([thread(), divider(), inp("Ask a follow-up", False)])]
    # "strip", Apollo: a quiet mono strip under the field, a square send
    def tag():
        return frame("Context", [mono("PRICING CARD", 10, "500", fill=MUTED)], layout="horizontal", alignItems="center", height=24,
                     padding=[0, 8], cornerRadius=6, fill=MUTEDBG)
    def inp(s, typed):
        return frame("Input", [field_text(s, typed), row([tag(), mark(24), SPACER(), send_btn(typed, shape="square")], gap=4)],
                     layout="vertical", gap=10, padding=[12, 10, 10, 12], width="fill_container")
    return [card([inp("Ask about this", False)], radius=12), card([inp(TYPED, True)], radius=12),
            card([thread("mono"), divider(), inp("Ask a follow-up", False)], radius=12)]

CHAT_VARIANTS = [
    ("toolbar", "A. Toolbar under the field", "After Cursor, LangChain and Plane. The field on top; the harness as a picker label left, send right, in one toolbar row."),
    ("header", "B. Header and footer", "After Ferndesk. A header says what the agent sees and which harness; each exchange between edge-to-edge dividers."),
    ("lastline", "C. Controls end the last line", "After Tana and Manus. No toolbar: the mark and send ride the field's last line as it grows."),
    ("pill", "D. A pill that opens up", "After Mistral and Grok. One centred line when empty, a card once it wraps; the thread floats above as its own card."),
    ("chip", "E. The selection as a chip", "After Notion and Langdock. A removable chip on top says what is asked about; mark left, send right."),
    ("strip", "F. Mono strip, square send", "After Apollo. A quiet mono tag under the field, square send; changes counted in mono."),
]
COLW = 28 + 8 + 300

def chat_board(x, y, dark=False):
    cols = []
    for key, title, note in CHAT_VARIANTS:
        col = [text(title, 15, "600"), text(note, 12, fill=MUTED, w=COLW)]
        for label, st in zip(["Empty", "Typing", "Thread"], chat_variant(key)):
            sp = spark(0, 0, True); sp.pop("x"); sp.pop("y")
            col += [text(label.upper(), 11, "600", fill=MUTED, letterSpacing=0.06),
                    frame("With spark", [sp, st], layout="horizontal", gap=8, alignItems="start")]
        cols.append(frame(title, col, layout="vertical", gap=12, width=COLW))
    grid = frame("Variations", cols, layout="horizontal", gap=48, x=CX, y=CY)
    cap = frame("Caption", [text("Chat variations", 17, "600"),
                            text("Six takes on talking to the selection, each empty, typing three lines, and after two exchanges. Send and the harness mark sit on the last line or in a bottom toolbar. The spark beside each one is unchanged.", 15, fill=MUTED, w=900)],
                x=CX, y=64, layout="vertical", gap=6)
    return frame("Chat variations" + (", dark" if dark else ""), [cap, grid], x=x, y=y, width=CX * 2 + 6 * COLW + 5 * 48,
                 height=CHAT_H, layout="none", fill=BOARD, clip=True)
CHAT_H = 1120
CHAT_X = 7840

# ---------- done toast variations: the real toast (apps/macos/DesignSystem/Components.swift, Toast), only the icon varies ----------
# A Liquid Glass capsule 40 pt tall (control 32 + 2 x pillPad 4), 16 pt side padding, 8 pt between icon and text, the text
# "Done: <summary>" in 12 pt medium, text colour, a soft lift (black 10%, radius 14, y 4). Today's icon:
# checkmark.circle.fill, hierarchical, 15 pt medium, in the ok green: a pale disc, barely there on light.
SUMMARY = "Send and the Claude mark sit on the last line in all six composers"

def toast(kind):
    dark = is_dark()
    label = [text("Done: " + SUMMARY, 12, "500")]
    if kind == "now":
        ic = [sf("checkmark.circle.fill", 15, "okdark" if dark else "ok")]
    elif kind == "check":
        ic = [box([sf("checkmark", 11, "fg")], 15)]
    elif kind == "green":
        ic = [box([sf("checkmark", 11, "greendark" if dark else "green")], 15)]
    elif kind == "circle":
        ic = [sf("checkmark.circle.fill", 15, "fg")]
    elif kind == "disc":
        ic = [frame("Disc", [sf("checkmark", 7, "fg" if dark else "white")], width=14, height=14, cornerRadius=7,
                    layout="horizontal", justifyContent="center", alignItems="center", fill="#D4D4D8" if dark else "#52525B")]
    elif kind == "claude":
        ic = [sf("claude", 16, "fg")]
    else:  # "word": no icon, the first word bold
        ic, label = [], [text("Done", 12, "700"), text(SUMMARY, 12, "500")]
    g = glass()
    g["effect"] = g["effect"][:3] + [{"type": "shadow", "offset": {"x": 0, "y": 4}, "blur": 28, "spread": 0, "color": "#0000001A"}]
    # SF draws capitals' centre about 1 pt above a 100% line box's centre at 12 pt: icons sit 1 pt higher to match.
    ic = [frame("Icon", ic, layout="vertical", padding=[0, 0, 1, 0])] if ic else []
    return frame("Toast", ic + [frame("Text", label, layout="horizontal", gap=4, alignItems="center")], layout="horizontal",
                 gap=8, alignItems="center", height=40, padding=[0, 16], cornerRadius=20, **g)

TOASTS = [("now", "Now", "checkmark.circle.fill, hierarchical, in the ok green. The pale disc is the barely visible part."),
          ("check", "1. Checkmark in text colour", "SF checkmark at the text's size, text colour. The plainest fix."),
          ("circle", "2. Filled circle in text colour", "checkmark.circle.fill, monochrome, text colour. Today's shape, full contrast."),
          ("disc", "3. Small grey disc", "A 14 pt neutral disc with a white check (dark: light disc, dark check)."),
          ("claude", "4. The harness mark", "The Claude mark (Codex when Codex ran) says who finished."),
          ("word", "5. No icon, bold Done", "The word does the work: Done in bold, the summary after it."),
          ("green", "6. Keep green, make it solid", "A plain checkmark in a darker green (green 700 on light)."),
          ]

def toast_board(x, y, dark=False):
    rows = []
    for kind, title, note in TOASTS:
        lab = frame("Label", [text(title, 13, "600"), text(note, 12, fill=MUTED, w=260)], layout="vertical", gap=6, width=260)
        stage = frame("Canvas", [toast(kind)], layout="horizontal", justifyContent="center", alignItems="center", width=640, height=72,
                      cornerRadius=12, fill=BG)
        rows.append(frame(title, [lab, stage], layout="horizontal", gap=24, alignItems="center"))
    grid = frame("Variations", rows, layout="vertical", gap=16, x=CX, y=CY)
    cap = frame("Caption", [text("Done toast", 17, "600"),
                            text("The toast an agent shows when it finishes, as the app draws it: a glass capsule, Done and the agent's summary. Only the icon changes.", 15, fill=MUTED, w=900)],
                x=CX, y=64, layout="vertical", gap=6)
    return frame("Done toast variations" + (", dark" if dark else ""), [cap, grid], x=x, y=y, width=CX * 2 + 260 + 24 + 640,
                 height=TOAST_H, layout="none", fill=BOARD, clip=True)
TOAST_H = 840

def new_boards():
    global PFX
    PFX = "cv"
    use("light", 0); a = chat_board(CHAT_X, 0)
    use("dark", 0); b = chat_board(CHAT_X, CHAT_H + 120, True)
    tx = CHAT_X + a["width"] + 120
    use("light", 0); c = toast_board(tx, 0)
    use("dark", 0); d = toast_board(tx, CHAT_H + 120, True)
    use("light", 0)
    return [clean(n) for n in (a, b, c, d)]

def clean(n):
    if isinstance(n, dict):
        return {k: clean(v) for k, v in n.items() if v is not None}
    if isinstance(n, list):
        return [clean(v) for v in n]
    return n

use("light", 0); light = make(""); light.insert(0, icons_board(-1640, False))
use("dark", 1020); dark = make(", dark"); dark.insert(0, icons_board(-1640, True))
use("light", 0); var_light = variations_board(0, 2140)
use("dark", 0); var_dark = variations_board(0, 3160); var_dark["name"] += ", dark"
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chat-to-selection.canvas", "document.json")
NEW = new_boards()
if "--merge" in sys.argv:
    # The file is live in Canvas and edited there: keep it, and only replace the boards this script adds later.
    with open(out) as f: doc = json.load(f)
    names = {b["name"] for b in NEW}
    doc["children"] = [c for c in doc["children"] if c.get("name") not in names] + NEW
    with open(out, "w") as f: json.dump(doc, f, indent=2, ensure_ascii=False)
    print(out, "merged", len(NEW), "boards"); sys.exit(0)
doc = {"version": "2.21", "children": [clean(b) for b in light + dark + [var_light, var_dark]] + NEW,
       "fonts": [{"name": "SF Mono", "url": "fonts/SF-Mono-Regular.otf", "weight": 400},
                 {"name": "SF Mono", "url": "fonts/SF-Mono-Medium.otf", "weight": 500}]}
with open(out, "w") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
print(out)
