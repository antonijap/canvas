# Design recipe for app screens and web pages (v5)

Read this before drawing in Canvas. A checker runs section 7 after you draw. Sizes are points (pt) on a 393 x 852 board unless a rule says otherwise.

Rule format: `R-<section>-<n>` [MUST or DEFAULT] **rule**. Why. Applies to. Check. Source.

How to read the tags:
- [MUST] breaks the design or the build when missed. The checker fails the board. Fix it.
- [DEFAULT] is where you start. Change it when the screen looks better or reads clearer another way, and keep the change consistent across boards. The checker only warns; answer a warning with a one-line reason or a fix.
- Order when rules collide: what the task asks for, then MUST, then Taste, then DEFAULT. Never cut or shrink requested content (posts, boards, copy, icon size) to satisfy a DEFAULT check.
- Numbers come as "range, default X". Pick inside the range, start at the default, and use the same value for the same role everywhere.

## Taste

What separates a top app from generic AI output. Read it first, check against it last.
- Familiar first. A person should name the app type in one second: borrow the layout, icons and order of the apps people use daily, then add identity through copy, one accent and content, not new patterns.
- Rhythm. Pick a few spacing values and repeat them. Equal things get equal gaps; groups are separated by clearly larger gaps. Uneven gaps read as mistakes.
- Alignment. Every column has one left edge: avatar, name, body text and the first action icon line up. Icons and their labels share a vertical centre.
- Restraint. One accent, used for the primary action and selection only. Chrome stays neutral; colour comes from content and avatars.
- No decoration without a job: no gradients on chrome, no glows, no tinted cards, no placeholder glyphs inside media boxes, no emoji in UI copy.
- Real pictures. Avatars, story photos and post media show real photos, never grey or tinted blocks. Placeholders read as a wireframe.
- Today's platform look. Bars and controls look like iOS now: a plain tab bar that runs to the bottom edge, ink for the active tab, no outlined or boxed bars.
- Official over drawn. Use the real platform pieces: the iOS status bar (9:41, signal, Wi-Fi, battery at Apple's positions) and the official App Store and Google Play badges. A hand-drawn look-alike reads as fake at once.
- Centred on small screens. On a phone-width marketing page, headlines, short copy, feature blocks and controls are centred or full width; left-aligned blocks with a side icon look lazy there.
- System first. Build the tokens and components before the screens; screens only place instances. The design with a real system won round 2.
- Show life. At least one post is in an interacted state, like a filled heart with its count.
- Real voice. Names, captions and counts that sound like people ("Took the long way home"), not "Lorem", "User 1" or "Check out this amazing post!".
- Short buttons. A verb and at most 2 more words, centred by layout with label line height 100 percent, never nudged by hand, no decorative icon.
- Generous but not empty. Content gets the space; chrome is thin. A first screen shows at least two items of the feed or list.
- Short empty states: a small icon, a plain headline, one short line why, one action. No second section with its own title and copy. Less text wins.
- Finish. Render, look at it at 100 percent, and fix anything that pulls the eye for the wrong reason before you hand off.

## 1. UX laws applied

- `R-1-1` [MUST] **Make every tappable element at least 44 x 44 pt and keep neighbouring targets from overlapping.** Why: small and crowded targets cause misses; the glyph can be smaller than its target. Applies to: all touch controls. Check: R-7-5, R-7-6.
- `R-1-2` [DEFAULT] **Put the controls people use most in the lower part of the screen (tab bar, sheet buttons, sticky footer).** Why: the thumb reaches the lower third with the least effort. Applies to: navigation, checkout, paywall, onboarding. Check: R-7-38.
- `R-1-3` [MUST] **Give each decision screen at most one filled primary action; every other action is secondary, outlined or text.** Why: one dominant option speeds the choice and only stands out when alone. Applies to: forms, onboarding, dialogs, paywalls, empty states. Check: R-7-14.
- `R-1-4` [DEFAULT] **Cap choices: at most 5 tabs, 3 plans, 6 options per survey step, 2 buttons in a dialog; group anything longer.** Why: each extra option slows the decision. Applies to: navigation, paywall, surveys, dialogs. Check: R-7-4, R-7-35.
- `R-1-5` [DEFAULT] **Preselect the option that fits the user's stated goal and say why in a few words.** Why: a reasoned default shortens the decision. Applies to: paywall, checkout, settings. Check: R-7-35.
- `R-1-6` [MUST] **Use the patterns people already know: back chevron top left, tabs at the bottom, heart for like, magnifier for search, the icon meanings in R-4-13, and the layout of the leading apps in the category.** Why: people bring habits from the apps they use most; a feed should be recognised at a glance. Applies to: all. Check: R-7-41; judgment for layout.
- `R-1-7` [DEFAULT] **Label tabs, headers and buttons with words users already use (Home, Search, Inbox, Profile) and name an action by its result.** Why: unfamiliar labels force learning. Applies to: navigation, buttons. Check: judgment.
- `R-1-8` [DEFAULT] **Group by spacing: the gap inside a group is at most half the gap between groups (4 and 12, or 8 and 16 to 24).** Why: proximity tells the eye what belongs together. Applies to: all. Check: R-7-21.
- `R-1-9` [DEFAULT] **Show a group with a shared surface or one full-width divider, never a border around every item.** Why: one shape shows membership. Applies to: lists, settings, feed posts. Check: R-7-19.
- `R-1-10` [MUST] **Make items with the same behaviour look and space the same (icon size, weight, colour, gap) and make links look different from body text.** Why: look-alikes read as one group; a stray size reads as a bug. Applies to: action rows, lists, tab bars. Check: R-7-18.
- `R-1-11` [DEFAULT] **Use plain shapes from one radius family: rectangles, circles and pills.** Why: simple forms are recognised faster. Applies to: all. Check: R-7-16.
- `R-1-12` [DEFAULT] **Remove every element the task does not need.** Why: chrome costs attention. Applies to: all. Check: judgment.
- `R-1-13` [DEFAULT] **Split long tasks into steps of 1 to 3 inputs and show real progress (step 2 of 4) whose total never grows.** Why: small chunks are easier; a surprise step breaks trust. Applies to: onboarding, checkout, forms. Check: R-7-28, R-7-36.
- `R-1-14` [DEFAULT] **Keep earlier choices and filters visible on the step that depends on them.** Why: working memory is short. Applies to: checkout, filters. Check: judgment.
- `R-1-15` [DEFAULT] **Draw a pressed, loading or optimistic state for each action so feedback can appear within 400 ms.** Why: slow acknowledgment breaks attention. Applies to: interactive components. Check: R-7-40.
- `R-1-16` [MUST] **For waits over 1 second show a skeleton shaped like the final layout; never fake progress.** Why: honest, familiar progress feels shorter. Applies to: feeds, search, payment. Check: R-7-27, R-7-28.
- `R-1-17` [DEFAULT] **Let horizontal rails cut their last visible item at the screen edge.** Why: an open edge signals more. Applies to: story rails, carousels. Check: R-7-37.
- `R-1-18` [DEFAULT] **End every flow on purpose with a result screen that confirms what happened and gives the next step.** Why: people judge a flow by its peak and its end. Applies to: checkout, posting, onboarding. Check: judgment.
- `R-1-19` [DEFAULT] **Accept messy input and show errors beside the field without clearing it.** Why: be liberal in what you accept. Applies to: forms, search. Check: R-7-40.
- `R-1-20` [MUST] **Never make content look like an ad or an ad look like content.** Why: disguise destroys trust. Applies to: feeds, promos. Check: R-7-39.
- `R-1-21` [DEFAULT] **Show a change where it happened (badge, inline toast, "New posts" pill).** Why: people miss changes outside their focus. Applies to: feeds, carts. Check: judgment.
- `R-1-22` [DEFAULT] **Put Home first and Profile last in a tab bar.** Why: ends of a row are remembered best. Applies to: tab bars. Check: R-7-4.
- `R-1-23` [DEFAULT] **Move work into the system: prefill, detect, compute, choose sensible defaults.** Why: someone must carry the complexity. Applies to: forms, checkout. Check: judgment.
- `R-1-24` [DEFAULT] **Teach a feature with one tip at first use, never more than 3 explainer screens up front.** Why: people start before they read. Applies to: onboarding. Check: judgment.
- `R-1-25` [MUST] **Pair colour with a second cue (filled versus outline icon, label, position) for every state.** Why: colour alone fails colour-blind users. Applies to: tabs, toggles, likes, validation. Check: R-7-40.
- `R-1-26` [DEFAULT] **Show numbers with units, time window and context.** Why: bare numbers mislead. Applies to: prices, stats, social proof. Check: judgment.

## 2. Flow patterns

### Onboarding
- `R-2-1` [MUST] **Deliver the core value before any ask: account, permissions and payment come after the first 1 to 3 value screens.** Why: asks before value spend trust not yet earned. Applies to: onboarding. Check: judgment.
- `R-2-2` [DEFAULT] **Ask one question per screen, easy first, 3 to 6 options plus Skip, only questions whose answer changes the experience; then use the answers visibly.** Why: small yeses build momentum; unused answers break a promise. Applies to: onboarding surveys. Check: R-7-35.
- `R-2-3` [DEFAULT] **Teach new objects with a working example the user can edit right away.** Why: a tour apart from use is hard to apply. Applies to: onboarding, create flows. Check: judgment.
- `R-2-4` [DEFAULT] **On "check your email" show the address, an "Open mail app" button, resend and change-address.** Why: leaving for the inbox loses people. Applies to: signup. Check: judgment.

### Permission asks
- `R-2-5` [MUST] **Never ask for a system permission on launch; ask right after the action it serves, behind your own pre-prompt with one "Allow" and a text "Not now".** Why: a declined pre-prompt can be asked again, a declined system dialog cannot. Applies to: notifications, location, contacts, photos. Check: R-7-14.
- `R-2-6` [DEFAULT] **Keep the app usable after a refusal and offer "Turn on in Settings".** Why: punishing a refusal destroys trust. Applies to: optional permissions. Check: judgment.

### Paywall and trial
- `R-2-7` [MUST] **Keep a 44 x 44 close button visible in the top 120 pt when access is optional, and show total, interval, renewal and cancel terms beside the buy button.** Why: a hidden close or hidden price feels like a trap. Applies to: paywall. Check: R-7-33, R-7-34.
- `R-2-8` [DEFAULT] **For trials show a timeline (today, reminder, charge day) and offer a reminder that does not need push permission.** Why: fear of a surprise charge blocks trials. Applies to: trials. Check: judgment.
- `R-2-9` [MUST] **No fake countdowns, pre-checked paid add-ons, asterisk fine print, "free" for something that renews, or shaming decline copy.** Why: dark patterns cost trust. Applies to: paywall, checkout, popups. Check: R-7-33; judgment.

### Checkout
- `R-2-10` [MUST] **Show items, fees, delivery date and the full total on the same screen as the pay button; add no new cost on the last step.** Why: surprise totals cause abandonment. Applies to: checkout. Check: R-7-33.
- `R-2-11` [DEFAULT] **Make the native pay button primary, prefill address and contact, label the final button with its amount ("Pay $24.00"), and end on a receipt.** Why: less typing, a clear ending. Applies to: checkout. Check: judgment.

### Offboarding and cancel
- `R-2-12` [MUST] **Keep cancel reachable under Account or Billing in at most 3 screens, surveys optional, no guilt, and confirm "Cancelled, active until <date>".** Why: an easy exit keeps goodwill. Applies to: cancellation. Check: judgment.

### Notifications
- `R-2-13` [DEFAULT] **Notify only about events the user chose, name the person and item, give one direct action, and back off when ignored.** Why: unrelated volume trains people to turn notifications off. Applies to: push, in-app. Check: judgment.

### Empty states
- `R-2-14` [MUST] **Give every empty state a headline, one line on why it is empty, and one action that fills it.** Why: a blank list is a dead end. Applies to: feeds, lists, inbox, search. Check: R-7-26.
- `R-2-15` [DEFAULT] **Make the empty state calm: icon 40 to 64 (default 48) in $text-2 or on a soft circle, headline 17 to 22, primary in ink ($text fill, $bg label) or a calm accent.** Why: a loud saturated block on a quiet screen pulls the eye away. Applies to: empty states. Check: R-7-13.
- `R-2-17` [MUST] **Keep the empty state short: icon, headline, one body line of at most 70 characters, one primary. Suggestions are optional and come as one compact block (a row of 3 to 5 avatars with names, or at most 3 list rows) with no title or description of their own.** Why: stacked titles, descriptions and lists crammed into one panel read as busy. Applies to: empty states. Check: R-7-26.
- `R-2-18` [MUST] **Centre the empty state block optically in the free space between the last element above it (top bar or rail) and the tab bar, not in the board.** Why: a block that sits high or low in its space looks unfinished. Applies to: empty states. Check: R-7-26.
- `R-2-19` [MUST] **An empty social feed shows one compact quick-add row of 3 to 5 people (photo, name, Follow) under the empty-state block, with no title or copy of its own.** Why: it keeps the screen calm and gives the person a one-tap way to fill the feed, which is the business goal. Applies to: empty feeds of social apps. Check: R-7-26.
- `R-2-16` [MUST] **Use scarcity, urgency and social proof only when true and state the reason.** Why: fabricated pressure destroys trust. Applies to: commerce, paywall, feeds. Check: judgment.

## 3. Visual rules, measured

How measured: 92 screens from 18 apps, 42 of them from 8 feed apps (Facebook, Instagram, Snapchat, TikTok, Pinterest, X, Threads, YouTube) and 50 from 10 comparison apps; 15 more feed screens viewed and 9 pixel-scanned. Images 1179 to 1181 px (3x of 393) or 1125 px (3x of 375), caption band excluded, pixels divided by 3. Medians use one exemplar per app. Edges about 1 pt accurate, font sizes about 2 pt. The ranges are what top apps actually use, so a value inside them is fine.

| Metric | Median | Range | n (apps) |
|---|---:|---|---:|
| Viewport | 393 x 852 | 375 x 812 to 393 x 852 | 18 |
| Top safe band | 59 | 44 to 59 | 18 |
| Bottom home band | 34 | 34 | 4 |
| App bar, all apps | 44 | 39 to 64 | 18 |
| App bar, feed apps | 48.5 | 44 to 60 | 8 |
| Side margin, all apps | 16 | 9 to 24 | 18 |
| Text margin, feed apps | 12 | 9 to 16 | 8 |
| Tab bar incl. home band | 83 | 76 to 94 | 15 |
| Tab icon ink | 21.9 | 18 to 28 | 16 |
| Feed avatar | 40 | 32 to 44.3 | 7 |
| Story ring outer | 92.7 | 92.7 | 2 |
| Primary button height | 48 | 40.3 to 52 | 8 |
| Single-line menu row | 52 | 44 to 56 | 6 |
| Post hairline | 0.33 | 0.33 | 2 |
| Body text | 15 | 14 to 17 | 18 |
| Caption | 12 | 12 to 14 | 18 |
| Compact nav title | 18 | 16 to 22 | 18 |
| Large title | 28 | 20 to 34 | 15 |
| Accent groups per screen | 2 | 0 to 5 | 18 |

### Platform-fixed
- `R-3-1` [MUST] **Draw iPhone boards at 393 x 852 (375 x 812 for the compact size).** Why: the two viewport families. Applies to: all iPhone screens. Check: R-7-1.
- `R-3-2` [MUST] **Reserve 59 pt at the top including the Dynamic Island (44 on 375 x 812) and 34 pt at the bottom; no tappable content inside them.** Why: the system owns those bands. Applies to: all. Check: R-7-2.
- `R-3-3` [MUST] **Make the tab bar a 49 pt control row plus the 34 pt home band (83 total), 3 to 5 equal slots.** Why: platform size. Applies to: apps with top-level sections. Check: R-7-4.
- `R-3-4` [MUST] **Make tap targets at least 44 x 44; the drawn glyph may be smaller.** Why: R-1-1. Applies to: all controls. Check: R-7-5.

### Ranges with a default
- `R-3-5` [DEFAULT] **App bar 44 to 56, default 44 on standard screens and 48 on a feed home; a timeline switch gets its own 44 row.** Why: feed bars carry a wordmark and up to 2 actions. Applies to: top-level screens. Check: R-7-3.
- `R-3-6` [DEFAULT] **Side margin 12 to 16: default 16 for text screens, 12 allowed in feeds; media may run edge to edge.** Why: feed apps cluster at 12, others at 16. Applies to: all. Check: R-7-20.
- `R-3-7` [DEFAULT] **Type scale: 34, 28, 22, 20, 17, 15, 13, 12, 11, 10; body 15 to 17 (default 15 in feeds, 17 elsewhere), meta 12 to 13, tab label 10 to 11.** Why: covers the measured roles with iOS-like steps. Applies to: all. Check: R-7-7.
- `R-3-8` [DEFAULT] **Body line height 1.3 to 1.4 (default 20 on 15); one-line labels lineHeight 1.** Why: measured body pitch 20 to 21. Applies to: text. Check: R-7-9.
- `R-3-9` [DEFAULT] **Regular for body plus one heavier weight (600 or 700) for names and titles; at most 3 weights per board.** Why: every feed app pairs regular with one bold. Applies to: all. Check: R-7-8.
- `R-3-10` [DEFAULT] **Avatars by role: post 36 to 44 (default 40), compact rows 28 to 36 (default 32), story ring 64 to 92 (default 76, photo 4 to 6 inside), profile 80 to 96; every avatar shows a photo (R-5-8), initials on a soft tone only as the no-photo fallback.** Why: identity size follows hierarchy; a 92 ring shows only 3 stories and crowds the first post. Applies to: feeds, stories, profiles. Check: R-7-17.
- `R-3-11` [DEFAULT] **Icons: 20 to 28 in bars and rows (default 24, 20 in dense rows), 40 to 64 for empty and error illustrations (default 48); one size per row.** Why: measured ink 18 to 28; state icons need presence. Applies to: tabs, actions, state panels. Check: R-7-18.
- `R-3-12` [DEFAULT] **Buttons: primary 44 to 52 (default 48), inline (Follow, Edit) 32 to 36, chips 32; list rows 44 to 56 (default 52), two-line rows 60 to 72.** Why: central measured sizes. Applies to: all. Check: R-7-33.
- `R-3-13` [DEFAULT] **Radius by structure: 0 for full-width media, 8 to 12 for inset media and cards, 8 for small tiles, 24 for sheet tops, height/2 for pills, avatars, chips and buttons.** Why: radius follows the container. Applies to: all. Check: R-7-16.
- `R-3-14` [DEFAULT] **One post separator style per feed: a 0.33 hairline, a 4 to 8 grey band, or whitespace under edge-to-edge media.** Why: mixing looks accidental. Applies to: feeds, lists. Check: R-7-19.
- `R-3-15` [DEFAULT] **Media boxes: 16:9, 4:3, 1:1 or 4:5; pick the ratio that lets the next post start in view when the task asks for several posts on one screen.** Why: a 4:5 photo plus a stories rail fills the whole viewport. Applies to: feeds. Check: R-7-43.
- `R-3-17` [MUST] **Draw the tab bar as one continuous surface ($bg or a translucent material) from its top edge to the bottom of the board, with at most a 0.33 hairline on top. No outline on the sides or bottom, no box that stops above the home band, no tinted bar fill. Active tab: filled icon and label in $text (ink); inactive: outline icon and label in $text-2. No accent colour in the tab bar.** Why: a boxed, outlined bar with a blue active tab looks years old. Applies to: tab bars. Check: R-7-4.
- `R-3-18` [DEFAULT] **Wordmark 22 to 26 (default 24), weight 600 to 700, tracking from the font's size chart; never 800 or heavier, never above 28.** Why: a heavy, oversized wordmark shouts over the content. Applies to: top bars. Check: R-7-47.
- `R-3-19` [DEFAULT] **Set type in the platform font (SF Pro) with Apple's tracking for each size, or Inter with its dynamic metrics; no hand-picked letter spacing or line heights outside the token scale.** Why: custom values on a system font make it look slightly wrong. Applies to: text. Check: R-7-9; judgment.
- `R-3-20` [MUST] **Use the standard iOS status bar: 54 tall on 393 x 852 with the Dynamic Island, time "9:41" in SF Pro Semibold 17 centred in the left ear, cellular, Wi-Fi and battery glyphs in the right ear, all in $text. Insert the Canvas status bar component when the MCP offers one; never draw your own glyphs.** Why: a drawn status bar is the first thing that looks off. Applies to: all iPhone boards. Check: R-7-50.
- `R-3-16` [MUST] **Keep chrome neutral and use the accent only for the one primary action and the selected state; red only for like, badges and destructive actions.** Why: colour that means everything means nothing. Applies to: all. Check: R-7-13.

## 4. Design system

Starting tokens for a new file. Reuse an existing coherent system first. Colours are authored choices; sizes come from section 3.

| Family | Values |
|---|---|
| Colour, light | `bg #FFFFFF`, `surface #F5F5F7`, `surface-2 #EBEBEF`, `text #171719`, `text-2 #626268`, `divider #E5E5EA`, `accent #175CD3`, `on-accent #FFFFFF`, `like #E5243B`, `danger #B42318`, `success #067647`, `scrim #00000066` |
| Colour, dark | `bg #101012`, `surface #1C1C20`, `surface-2 #2A2A30`, `text #F5F5F7`, `text-2 #B4B4BE`, `divider #38383F`, `accent #8CB8FF`, `on-accent #10213B`, `like #FF5468`, `danger #FFB4AB`, `success #75D5B6`, `scrim #00000099` |
| Avatar tones | 4 to 6 soft tones (sand, sage, sky, rose, plum, clay), each with light and dark values |
| Type (size/line) | `large 34/41`, `title 28/34`, `title-2 22/28`, `title-3 20/25`, `headline 17/22`, `body 15/20`, `meta 13/18`, `caption 12/16`, `small 11/13`, `tab 10/12` |
| Weights | `400`, `600`, `700` (500 allowed for controls) |
| Spacing | `0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64` |
| Radius | `0, 4, 8, 12, 16, 20, 24`, `full = height/2` |
| Sizes | `target 44`, `icon 24`, `icon-dense 20`, `icon-state 48`, `button 48`, `button-inline 32`, `row 52`, `avatar 32/40/96`, `story-ring 76` |
| Geometry | `top 59` (`44` compact), `bottom 34`, `bar 44`, `bar-feed 48`, `tabs 83`, `margin 16`, `margin-feed 12`, `hairline 0.33` |
| Elevation | `flat` none; `overlay` y 2 blur 8 black 8% plus y 12 blur 32 black 12%, for sheets, menus, toasts, floating buttons only |

- `R-4-1` [MUST] **Bind every fill, stroke, font size, gap, padding and radius to a variable; no raw hex on layers.** Why: one change updates every screen and dark mode needs pairs. Applies to: all. Check: R-7-11.
- `R-4-2` [MUST] **Keep text at 4.5:1 and large text (18+, or 14+ bold) and icons at 3:1 against their real background in light and dark.** Why: legibility. Applies to: all. Check: R-7-12.
- `R-4-3` [DEFAULT] **On tinted surfaces use a secondary text colour of the same hue, not neutral grey.** Why: grey on tint loses hierarchy and contrast. Applies to: notices, selected panels. Check: R-7-12.
- `R-4-4` [DEFAULT] **Use elevation only for floating layers; posts and cards stay flat and separate by surface, hairline or space.** Why: shadows mean depth. Applies to: all. Check: R-7-22.
- `R-4-5` [MUST] **Build every part that repeats 2 or more times as a component and place instances: Top bar, Tab bar, Tab item, Post, Post header, Action bar, Action, Avatar, Button, Icon button, List row, Skeleton, State panel.** Why: one source of truth; round 1's winner did this and the plain runs did not. Applies to: all. Check: R-7-25.
- `R-4-6` [DEFAULT] **Give Button default, pressed, disabled, loading; Input empty, focused, filled, error, disabled; Post default, liked, expanded; Avatar image and initials.** Why: code needs every state. Applies to: components. Check: R-7-40.
- `R-4-7` [MUST] **Give like, save, follow and toggles on and off states that differ in shape or label, not only colour.** Why: R-1-25. Applies to: actions. Check: R-7-40.
- `R-4-8` [MUST] **Use one icon library per file and one stroke weight, and pick the most common glyph for each meaning (the map in R-4-13); no unusual variants such as teardrop bubbles, sparkles or custom shapes.** Why: mixed drawing styles look broken. Applies to: all. Check: R-7-18.
- `R-4-9` [MUST] **Build buttons as horizontal auto layout frames: justify center, align center, equal left and right padding, label lineHeight 1 (100 percent, never 1.2 or 129.4 percent), no hand offsets or absolute labels.** Why: a tall line box pushes the label off centre. Applies to: all buttons. Check: R-7-45.
- `R-4-10` [MUST] **Write button labels as a verb plus at most 2 words ("Follow", "Find people", "Try again").** Why: long labels wrap, crowd icons and slow reading. Applies to: all buttons. Check: R-7-45.
- `R-4-14` [MUST] **No icon inside a text button unless it adds meaning the label lacks (a brand logo on a sign-in button, a lock on a secure pay button).** Why: a decorative icon makes the button longer and harder to centre. Applies to: buttons. Check: R-7-45.
- `R-4-15` [MUST] **Build the design system first: a board named "Design system" with the tokens as variables and every component from R-4-5 with its states. Screens then hold only instances and layout frames.** Why: one source of truth, and it was the clearest win in round 2. Applies to: every file with 2 or more screens. Check: R-7-49.
- `R-4-11` [DEFAULT] **Keep motion brief and interruptible with a reduced-motion version.** Why: motion must never be needed to understand a state. Applies to: likes, refresh. Check: judgment.
- `R-4-12` [DEFAULT] **Avoid gradients, glows, tinted cards and decorative strokes on chrome; a story ring is the one common exception.** Why: decoration without a job reads as generic output. Applies to: all. Check: R-7-22; judgment.
- `R-4-13` [MUST] **Use these icon meanings: house home, magnifying-glass search, plus create, heart like, chat-circle comment, repeat repost, paper-plane share, bookmark save, bell activity, paper-plane or chat bubble for messages, user profile, dots-three more, x close, caret-left back. Never an envelope for messages: it reads as email.** Why: Jakob. Applies to: all. Check: R-7-41.

## 5. Ready for code

Canvas facts: frames have `layout` none, horizontal or vertical, plus `gap`, `padding` (one number, [v, h] or [t, r, b, l]), `alignItems`, `justifyContent`; width and height are numbers, `fill_container` or `fit_content`; icons are `{type: "icon", library, icon}`; instances are `type: "ref"`.

- `R-5-1` [MUST] **Name every layer by role in plain words (Feed, Top bar, Post, Post header, Avatar, Like action); name boards "<Screen> / <State>".** Why: names become component, test and route names. Applies to: all. Check: R-7-24.
- `R-5-2` [MUST] **Use auto layout for every frame with 2 or more children in a row or column; absolute position only for overlays (badges, floating pills).** Why: auto layout maps to stacks and flex; hand placement breaks with longer names. Applies to: all. Check: R-7-22.
- `R-5-3` [MUST] **Size with intent: containers fill width, text stacks fit height, fixed sizes only for icons, avatars, targets, button heights, media and the board; no fit_content parent with a fill_container child on the same axis.** Why: screens must survive 375 and 430 widths. Applies to: all. Check: R-7-23.
- `R-5-4` [DEFAULT] **Give one-line labels lineHeight 1 and wrapping text fixed-width growth with lineHeight 1.2 to 1.4.** Why: labels and paragraphs size differently. Applies to: text. Check: R-7-9.
- `R-5-5` [MUST] **Draw every board and state the task asks for; add error, caught-up and interaction states when the task asks for all states, or as extra boards after the requested ones are done.** Why: missing requested boards fail the task; unrequested boards must never cost quality on the requested ones. Applies to: data screens. Check: R-7-26.
- `R-5-6` [DEFAULT] **Fill with real lengths: names 3 to 30 characters, posts from one short line to a few lines, counts from none to 12.4K, counts of zero hidden.** Why: ideal content hides overflow. Applies to: all. Check: R-7-31.
- `R-5-7` [MUST] **No lorem, "User 1" or placeholder copy; placeholder people and places only (Anna, Ben, Mia, Studio, example.com).** Why: realism and repo privacy. Applies to: all. Check: R-7-31, R-7-44.
- `R-5-8` [MUST] **Keep text as text and icons as icon nodes, and fill every avatar, story photo and post media box with a real photo: an image fill `{type: "image", url: "media/<file>", mode: "fill"}` on a fixed-ratio rectangle or round avatar frame. Take photos from the image pack the task names (copy the files into `<Name>.canvas/media/`). Only when no image source exists, use a solid $surface-2 fill with no glyph, and say so in the report.** Why: grey blocks look like a wireframe; real photos show whether the layout works. Applies to: avatars, stories, media. Check: R-7-43.
- `R-5-9` [MUST] **Leave no hidden, zero-opacity, empty or off-board layers.** Why: noise in code. Applies to: all. Check: R-7-42.
- `R-5-10` [MUST] **Render every board, look at it at 100 percent, fix what looks wrong, then answer every checker failure and warning.** Why: JSON checks do not prove the render looks right. Applies to: final review. Check: judgment.

## 6. Recipes

### 6.1 Social feed (iPhone), in full

Default: photo and text feed, light theme, board 393 x 852, fill $bg, layout vertical, gap 0, padding 0, clip on. Height budget: 59 status + 48 top bar + 662 viewport + 83 tab bar = 852. A stories rail of about 104 leaves about 558 for posts: one photo post with 16:9 or 4:3 media plus the start of a second post. Plan the media ratio from that budget.

Structure top to bottom:

1. **Status bar** 393 x 59: time 17 semibold left, system icons right, centred in the lower 44.
2. **Top bar** 393 x 48, horizontal, padding [0, 4, 0, margin], align center. Wordmark 22 to 26, weight 600 to 700 (R-3-18), fill_container. Right: up to 2 icon buttons 44 x 44 with 24 icons (activity heart or bell, messages paper-plane).
3. **Stories rail** (optional) about 104 tall, horizontal, padding [8, margin], gap 12, clip on. Story item vertical, gap 4: ring 64 to 92 (default 76) around the photo, name 12 one line. "Your story" first: your own photo, no ring, a plus badge 20 to 24 at its lower right (R-6-10). At least 4 items show and the next is cut by the edge.
4. **Feed list**, vertical, fill_container both ways, clip on, repeating Post instances of one anatomy:
   - **Photo post**: Post header 56 tall, horizontal, padding [8, 4, 8, margin], gap 8 to 12, align center: Avatar 40, name stack (name 15 semibold, meta 13 $text-2, gap 2), more button 44. Media full width, radius 0. Action bar. Caption 15/20 with name semibold, up to 4 lines then "more".
   - **Text post**: header as above, body 15/20 at the same left edge as the caption text, then the Action bar.
   - **Separator**: one style per feed (R-3-14).
5. **Action bar** (component), horizontal, height 44, align center, padding [0, margin], gap 16 to 24 (default 20) between actions, spacer, save last. Each action is its own horizontal frame: width fit_content, height 44, align center, gap 4 to 6 (default 6) between icon and count. Icons 22 to 24, one size; counts 13 to 15 regular, lineHeight 1, hidden at zero. The first icon's left edge sits on the post text's left edge; save's right edge sits on the right margin. No fixed-width slots with centred content: they move the icon edge with the count's width.
6. **Tab bar** 83, one $bg surface to the board's bottom edge (R-3-17): 0.33 hairline on top, 49 control row with 5 Tab items fill_container, icons 24, labels 10 optional; 34 home band in the same surface. Order Home, Search, Create, Activity, Profile. Active: filled icon in $text; inactive: outline in $text-2. No accent, no outline box.

Build the "Design system" board first (R-4-15). Components: Status bar, Top bar, Story item, Avatar, Post, Post header, Action bar, Action, Icon button, Button, Tab item, Tab bar, Skeleton post, State panel, List row.

Boards:
- `Feed` (always): at least 2 posts, the second starting above the tab bar; a third may be cut by the tab bar. One photo post, one text-only post, one long name, counts like 128 and 1,284, and one post already liked (filled heart in $like, R-6-11). Real photos in every avatar and media box. Never shrink type, media or margins to fit more posts.
- `Feed / Loading` (when asked): same chrome; skeleton posts in $surface-2 matching the real post geometry (circle 40, bars 120 to 160 x 12 and 80 to 100 x 10 radius 4, media block of the same ratio, action dots); no text or numbers in the list.
- `Feed / Empty` (when asked): same chrome. State panel in the upper half: icon 48 $text-2, headline "Your feed is empty" 20 semibold, one line why 15 $text-2 ("Follow people to see their posts here."), one primary "Find people" 48 in ink or a calm accent. Optional: one compact row of 3 to 5 suggested people (photo avatar, first name, small Follow) between the line and the primary, with no title of its own (R-2-17). Keep "Your story" if the feed has stories.
- `Feed / Error`, `Feed / Caught up`, `Post / States`: extras. Add when the task asks for all states, or after the requested boards are done. Error keeps cached posts with a banner and "Retry", or shows a State panel with "Try again". Caught up is a card that breaks the post pattern with "You're all caught up" and "See older posts".

Content: friends sharing everyday photos and short updates; captions sound like people ("Took the long way home. The river was so quiet."); times "2h", "Yesterday"; no emoji in UI copy.

Feed rules:
- `R-6-1` [MUST] **Pick one feed anatomy (photo, text thread, video, masonry) and keep every post on it as instances of one Post component.** Why: mixing looks accidental. Applies to: feeds. Check: R-7-25.
- `R-6-2` [MUST] **Keep status bar, top bar, feed viewport and tab bar as named regions whose heights add up to the board.** Why: avoids double-counted safe areas. Applies to: feed boards. Check: R-7-3.
- `R-6-3` [MUST] **Lay out the action row as in step 5: icon and count share one vertical centre, counts sit a fixed gap after their icon, gaps between actions are equal, and the first icon aligns with the post text's left edge.** Why: an uneven, off-axis action row was the main flaw in the best round 1 design. Applies to: posts, comments, cards with actions. Check: R-7-46.
- `R-6-4` [DEFAULT] **Give content at least 70 percent of the viewport; chrome stays thin and neutral.** Why: people came for the content. Applies to: feeds. Check: judgment.
- `R-6-5` [DEFAULT] **Show author, time or place and a 44 more button on every post.** Why: ownership and safety controls belong to each item. Applies to: feeds. Check: R-7-5.
- `R-6-6` [DEFAULT] **Show a stories rail only when the product has stories, and cut its last visible item.** Why: the rail spends a fifth of the first view. Applies to: story feeds. Check: R-7-37.
- `R-6-7` [DEFAULT] **Keep loaded posts during a refresh failure with retry beside it; never insert new posts above the reader, offer a "New posts" pill.** Why: partial failure must not erase content; unrequested movement breaks reading. Applies to: feeds. Check: R-7-29.
- `R-6-8` [DEFAULT] **Give long feeds a caught-up card that looks different from a post.** Why: an endless feed with no stop is a dark pattern. Applies to: feeds. Check: R-7-30.
- `R-6-10` [MUST] **Start a stories rail with "Your story": your own photo and a plus badge.** Why: it is how every story app lets you post; a rail without it looks like a copy. Applies to: story rails. Check: R-7-48.
- `R-6-11` [DEFAULT] **Show at least one post in an interacted state: a filled heart in $like with its count, or a filled bookmark.** Why: a feed where nothing has been touched looks like a template. Applies to: feeds. Check: R-7-40.
- `R-6-9` [MUST] **Label sponsored posts "Sponsored" with the sponsor and give every post Hide, Report and Block in its more menu.** Why: commercial context and control. Applies to: feeds. Check: R-7-39.

Checklist:
- [ ] 393 x 852; regions sum to 852; status 59, tab bar 49 + 34.
- [ ] Every requested board present; Feed shows 2 posts, the second starts in view.
- [ ] One margin (12 to 16) for all text; avatar, name, body and first action icon share a left edge.
- [ ] Action rows: equal gaps, icon and count centred together, fixed icon-count gap; every post uses the same Action bar instance, so icons sit at the same x in every post.
- [ ] Real photos in avatars, stories and media; one post liked.
- [ ] Tab bar plain, runs to the bottom edge, active in ink. Your story first with a plus.
- [ ] Empty state: icon, headline, one line, one action, nothing more than one compact suggestion row.
- [ ] Buttons: auto layout, centred, equal padding, verb first, 3 words max.
- [ ] Accent only on the primary and selection; empty-state primary in ink or a calm accent.
- [ ] Design system board first; every post an instance of one Post; tokens bound; one icon library, common glyphs, no envelope; every layer named.
- [ ] Rendered at 100 percent and compared against the Taste list.

### 6.2 Onboarding
- 3 to 6 boards. First: value in one sentence plus the product in use; primary "Get started" 48 at the bottom; "Log in" text button.
- One question per board, option rows 56, progress bar 4 tall at top, back chevron, Skip.
- Permission and paywall only after first value; last board a personal result, then home.
- Rules: R-2-1 to R-2-4, R-1-13, R-1-24.

### 6.3 Permission ask
- Own pre-prompt board right after the triggering action: icon 48 to 96, headline naming the benefit, 2 or 3 example rows.
- Primary "Allow" 48; text "Not now". Denied state keeps the feature usable with "Turn on in Settings".
- Rules: R-2-5, R-2-6.

### 6.4 Paywall
- Close button 44 in the top 120 pt. Outcome headline, at most 3 benefits, trial timeline.
- 2 or 3 plan cards 64 to 80 tall, radius 12, one preselected with a 2 pt $accent stroke.
- Price, interval and charge date above the 48 primary; Restore and Terms as text links.
- Rules: R-2-7 to R-2-9, R-1-4, R-1-5.

### 6.5 Settings
- Large title 34, search field 36, 16 margins. Grouped lists on $surface radius 12, rows 52, icons 24, chevron or toggle.
- Log out and Delete account last, in $danger.
- Rules: R-1-8, R-1-9, R-2-12.

### 6.6 Profile
- Avatar 80 to 96, name 20 bold, handle 15 $text-2, bio up to 3 lines, stats 15 semibold over 13 labels.
- At most 2 buttons, 32 to 36 tall. Segmented tabs 44; 3-column grid with 2 gaps, or the feed Post.
- Boards: own, other, empty, private, loading.
- Rules: R-3-10, R-3-12, R-2-14.

### 6.7 Search
- Field 36 to 44, radius full, $surface, magnifier 20, clear button, Cancel.
- Idle: recent searches, then suggestions. Typing: grouped results, best match first. No results: repeat the query, suggest a fix.
- Rules: R-1-4, R-1-14, R-1-19.

### 6.8 Checkout
- Summary with items, fees, delivery date, total; prefilled address and payment; native pay button 48, sticky above the home band.
- Boards: review, invalid field, processing, failed with data kept, success with receipt.
- Rules: R-2-10, R-2-11, R-1-2.

### 6.9 Marketing website
- Desktop 1440 wide, content column 1120 to 1200; mobile 393 wide, reflowed, not scaled.
- Hero: headline, one supporting line, one primary action. App downloads use the official App Store and Google Play badges (Apple's badge from its marketing tools, Google's from its badge page), black, never redrawn or restyled.
- Sections: features (3), social proof, pricing (at most 3 plans), FAQ, footer. One accent; section rhythm from one spacing step.
- Mobile: centre the hero, section headings, short copy and feature blocks (icon above title); segmented controls centred or full width; buttons full width. Long text (FAQ answers, legal) stays left aligned.
- Rules: R-1-3, R-1-4, R-5-8, R-6-12, R-6-13 to R-6-28.

- `R-6-12` [MUST] **On marketing pages use the official store badges and centre short content on phone widths.** Why: a fake badge looks untrustworthy; left-aligned short blocks on a phone look lazy. Applies to: websites and landing pages. Check: R-7-51.

#### Website hero
From a study of 30 strong heroes (app sites, award winners, top-rated concepts). The hero is the first viewport: promise, one action, and the product shown doing its job.
- Lead with the task in two lines, then one line on how, then the official store badge, then a verified rating if one exists.
- Show the product: a cropped device, UI cards lifted out of the app, or a photo with a UI overlay. Never a tall bare phone alone.
- Give the hero one focal colour (a colour field, tinted panel or saturated product art). All-grey heroes read as unfinished.
- Mobile: copy, badge, then art, centred, art inside 16 px gutters.
- `R-6-13` [MUST] **Fit the promise and conversion action in the first viewport.** Why: Both need to be available on arrival. Applies to: website hero. Check: At 1440×900, 390×844 and 320×568 CSS px, the H1 and primary action must have fully visible bounding boxes at scroll position zero.
- `R-6-14` [MUST] **Give one action primary emphasis beside or immediately after the copy.** Why: The next step should be obvious even if the nav collapses. Applies to: website hero. Check: Use one primary action group in the hero body. Two platform badges for the same install goal count as one group.
- `R-6-15` [MUST] **Use the official App Store badge when the primary action is iPhone installation.** Why: The badge identifies the store and the action at a glance. Applies to: website hero. Check: Use Apple's unmodified localized badge asset and link it to the live App Store listing.
- `R-6-16` [DEFAULT] **Start with two headline lines.** Why: A short headline leaves room for context, action and art. Applies to: website hero. Check: Measure wrapped text lines at 1440 and 390 CSS px. Aim for one to three and inspect any four-line exception at the shortest viewport.
- `R-6-17` [DEFAULT] **Use display-size type and constrain the headline's measure.** Why: A legible promise can share the frame with a meaningful visual. Applies to: website hero. Check: Start at 72–80 CSS px at 1440 and 32–50 CSS px at 390. Aim for the longest desktop line to span 25–60% of the viewport. Let mobile use the available width inside its gutters.
- `R-6-18` [DEFAULT] **Give the visual enough room to read in the first viewport.** Why: The art should explain the product or put its benefit in context. Applies to: website hero. Check: For a split or stack, start with a visible artwork bounding area around 20–50% of the viewport. Evaluate a full-bleed scene by the visibility of its focal subject.
- `R-6-19` [MUST] **Show a recognizable task or state when the app is the hero's subject.** Why: Visitors need to see what they can do. Applies to: website hero. Check: At 390 CSS px, identify one real app screen or UI state and its task without zooming.
- `R-6-20` [MUST] **Never use a tall, bare phone as the sole art direction.** Why: A full device outline can dictate the height of the entire hero. Applies to: website hero. Check: If an upright phone is the only art, crop to the useful UI, extract a key interface part, or give it product-specific context. Check that the essential app state survives the crop.
- `R-6-21` [DEFAULT] **Use color in the product, subject or background to establish a focal point.** Why: A clear palette helps the viewer find the art or action. Applies to: website hero. Check: Name the focal color and verify contrast for text and actions. For a muted palette, identify the subject through tone, scale or contrast.
- `R-6-22` [DEFAULT] **Limit vertical gaps between the action and the art.** Why: Oversized gaps can push the first glimpse of the product past the fold. Applies to: website hero. Check: Keep the action center within 18% of viewport height of the art's visible vertical span unless a larger gap leaves both elements clear and visible.
- `R-6-23` [DEFAULT] **Place one attributable proof signal near the action when available.** Why: A rating, press mention or result can answer hesitation in one line. Applies to: website hero. Check: Verify the source, place proof near the action or just beneath the hero composition, and remove any placeholder claim or logo.
- `R-6-24` [MUST] **Keep the mobile product visual within the viewport minus its side margins.** Why: A desktop-width asset can cause horizontal scroll or hide the product. Applies to: website hero. Check: At 320, 390 and 430 CSS px, the art box width must fit the viewport minus both gutters. Start with 16 px per side for stacked art. Clip full-bleed decoration inside its container and check that document scroll width equals viewport width.
- `R-6-25` [DEFAULT] **Stack mobile copy, primary action, then art.** Why: The action stays reachable while the visual can continue below the fold. Applies to: website hero. Check: At 390 CSS px, the CTA ends before the main art begins in a stack. For an overlay, verify text, action and contrast at 320 CSS px.
- `R-6-26` [DEFAULT] **Center the mobile visual as a group and simplify its edges.** Why: Recomposition keeps the focal UI readable and in frame. Applies to: website hero. Check: Center the art box within its content area to within 8 px. Scale or crop decorative artwork independently of the focal UI.
- `R-6-27` [DEFAULT] **Collapse mobile nav to the essential controls.** Why: A short header leaves room for the promise and action. Applies to: website hero. Check: At 390 CSS px keep the logo, menu and at most one conversion action in the header. Keep the primary hero action visible.
- `R-6-28` [DEFAULT] **Choose a composition that suits the focal asset.** Why: A crop, a layered visual and a full scene need different space around the copy. Applies to: website hero. Check: Use a split for two independent content blocks, a stack for a wide art object, or an overlay with an explicit text-safe zone.

### 6.10 Web dashboard
- 1440 x 900; sidebar 240 to 264; content padding 32; totals row, one chart, one table with status pills.
- Give it one moment of character so it is not generic: a brand-coloured totals card, a real avatar per client, or an illustrated empty state.
- Boards: dashboard, detail or editor, empty account.
- Rules: R-1-3, R-2-14, R-2-17.

## 7. Checks

Run on every top-level board and its descendants; expand `type: "ref"` instances with overrides; resolve `$name` through the file's variables. Name patterns are case-insensitive. A file's own variables extend the scales. [MUST] checks fail the board. [DEFAULT] checks warn: the agent fixes the value or keeps it with a one-line reason. A check never asks to remove or shrink content the task requested.

- `R-7-1` [MUST] **Board size.** Why: R-3-1. Applies to: top-level boards. Check: width in {375, 393} and height in {812, 852}, or height >= 852 for a board named /full/.
- `R-7-2` [MUST] **Safe bands.** Why: R-3-2. Applies to: iPhone boards. Check: no node named /button|tab|input|link|chip/ outside "Status bar" has absolute y < 59 (44 on 812); none has bottom edge > height - 34 unless inside "Tab bar".
- `R-7-3` [DEFAULT] **App bar and region sum.** Why: R-3-5, R-6-2. Applies to: boards with a child named /top bar|app bar|header/. Check: height 44 to 56; on feed boards Status bar, Top bar, optional switch, Feed list and Tab bar heights sum to the board height (this part MUST).
- `R-7-4` [MUST] **Tab bar.** Why: R-3-3, R-1-22. Applies to: nodes named /tab bar/. Check: height 83 (or 49 followed by a 34 home band); 3 to 5 slots, each fill_container; every slot has an icon and a label (MUST); exactly one active slot (filled icon or name /active|selected/); no stroke except a top hairline <= 1; no $accent fill or icon colour inside; the bar's bottom edge equals the board's bottom edge. Warn (DEFAULT) when the first slot is not home.
- `R-7-5` [MUST] **Hit areas.** Why: R-1-1, R-3-4. Applies to: nodes named /button|tab|chip|toggle|link|more/ and frames whose only child is an icon. Check: width and height >= 44, except inline buttons and chips >= 32 tall inside a row >= 44, and actions inside an Action bar that hug their content when the bar is >= 44 tall and its gap is >= 16.
- `R-7-6` [MUST] **Target spacing.** Why: R-1-1. Applies to: frames whose children are all hit areas. Check: no two children overlap; centre-to-centre pitch >= 44.
- `R-7-7` [DEFAULT] **Type scale.** Why: R-3-7. Applies to: text nodes. Check: fontSize in {10, 11, 12, 13, 15, 17, 20, 22, 28, 34}, or another size from 10 to 34 used for one role consistently; never below 10 (MUST).
- `R-7-8` [DEFAULT] **Weights.** Why: R-3-9. Applies to: each board. Check: distinct fontWeight values <= 3.
- `R-7-9` [DEFAULT] **Line height.** Why: R-3-8, R-5-4. Applies to: text nodes. Check: single-line auto text lineHeight 1; multi-line text 1.2 to 1.4; never < 1 (MUST).
- `R-7-10` [DEFAULT] **Fonts.** Why: R-3-7. Applies to: each board. Check: distinct fontFamily values <= 2.
- `R-7-11` [MUST] **Colour tokens.** Why: R-4-1. Applies to: fills, strokes and effect colours on non-image nodes. Check: value is a $variable.
- `R-7-12` [MUST] **Contrast.** Why: R-4-2. Applies to: text and icons over a solid ancestor fill. Check: ratio >= 4.5 below 18 pt (14 bold), else >= 3; icons >= 3; light and dark.
- `R-7-13` [MUST] **Accent use.** Why: R-3-16, R-2-15. Applies to: each board. Check: nodes filled $accent are only the primary button, a selected state, a badge or a story ring, with at most one accent-filled button per board; $like and $danger only on hearts, badges <= 20 pt or nodes named /delete|log out|report|block/. Warn (DEFAULT) when an empty-state primary uses a fill other than $text or $accent with HSL saturation > 80 percent.
- `R-7-14` [MUST] **One primary.** Why: R-1-3. Applies to: boards named /empty|error|onboarding|permission|paywall|checkout|form/. Check: nodes named /primary/ or accent-filled buttons number at most 1, and exactly 1 on empty, permission and paywall boards.
- `R-7-15` [DEFAULT] **Spacing scale.** Why: R-4-1. Applies to: frames. Check: gap and padding values in the spacing list or a spacing variable.
- `R-7-16` [DEFAULT] **Radius scale.** Why: R-3-13. Applies to: nodes with cornerRadius. Check: in the radius list or min(width, height)/2; media wider than 380 has radius 0.
- `R-7-17` [DEFAULT] **Avatars.** Why: R-3-10. Applies to: nodes named /avatar/. Check: 24 to 96 and round; width = height and one size per list (both MUST).
- `R-7-18` [MUST] **Icons.** Why: R-3-11, R-4-8, R-1-10. Applies to: icon nodes. Check: width = height; one library across the file; sibling icons in one row share size and fill; size 16 to 28 in bars, rows and buttons, 32 to 64 in nodes named /state|empty|error|illustration/. Values inside those ranges pass; off the defaults is not a warning.
- `R-7-19` [DEFAULT] **Separators.** Why: R-3-14. Applies to: nodes named /separator|divider|hairline/. Check: full parent inner width; height <= 1 or 4 to 8; all separators in one Feed list share height and fill.
- `R-7-20` [DEFAULT] **Side margins.** Why: R-3-6. Applies to: text and control frames in content columns. Check: left inset 12 to 16; text beside a leading avatar may start after it; only /media|image|photo|video|rail|grid/ start at x 0. One inset value for every text column on a board (MUST).
- `R-7-21` [DEFAULT] **Grouping distances.** Why: R-1-8. Applies to: vertical frames whose children are frames with a gap. Check: child gap * 2 <= parent gap when parent gap > 0.
- `R-7-22` [MUST] **Auto layout and decoration.** Why: R-5-2, R-4-4, R-4-12. Applies to: frames. Check: frames with >= 2 children have layout horizontal or vertical unless named /overlay|badge|floating|status bar|pill/. Warn (DEFAULT) on shadows outside /sheet|menu|toast|floating|pill/, on strokes or shadows on Post, and on gradient fills outside /story|ring/.
- `R-7-23` [MUST] **Sizing modes.** Why: R-5-3. Applies to: frames and text. Check: text over 40 characters has width fill_container or a fixed width with fixed-width growth; Post and list rows have fit_content height; no fit_content frame with a fill_container child on the same axis; icons, avatars and targets have numeric sizes.
- `R-7-24` [MUST] **Names.** Why: R-5-1. Applies to: all nodes. Check: no name matches /^(frame|group|rectangle|ellipse|text|vector|line|image|copy)( \d+)?$/ or an auto id like /_(text|rect|icon|frame)-\d+$/.
- `R-7-25` [MUST] **Reuse.** Why: R-4-5, R-6-1. Applies to: each board. Check: a subtree with the same node types and child counts repeated 2 or more times is an instance of one component; all Post nodes in a Feed list reference one component.
- `R-7-26` [MUST] **Requested boards and empty anatomy.** Why: R-5-5, R-2-14. Applies to: the file. Check: every board the task names exists; an Empty board has a title text 17 to 22, one body text of at most 70 characters, one primary, and no other text over 13 pt except names inside one suggestion block (required on empty social feeds, R-2-19); the block's centre sits within 24 of the centre of the free space between the element above it and the Tab bar. Error, Caught up and Post / States are checked only when present or requested.
- `R-7-27` [MUST] **Loading board shape.** Why: R-1-16. Applies to: boards named /loading/. Check: Top bar and Tab bar heights match the default board; >= 2 nodes named /skeleton/; no text with digits inside the Feed list.
- `R-7-28` [MUST] **No fake progress.** Why: R-1-13, R-1-16. Applies to: nodes named /progress/. Check: "n of m" has 1 <= n <= m, with the same m on every board of the flow.
- `R-7-29` [DEFAULT] **Error board shape.** Why: R-6-7. Applies to: boards named /error/. Check: a button with text /retry|try again/; Tab bar kept when the default board has one.
- `R-7-30` [DEFAULT] **Caught-up board.** Why: R-6-8. Applies to: boards named /caught up/ when present. Check: a text matching /caught up/ and one button.
- `R-7-31` [MUST] **Content realism.** Why: R-5-6, R-5-7. Applies to: text nodes and Feed boards. Check: no text matches /lorem|ipsum|user \d|placeholder/; Feed boards have >= 2 Post nodes whose top edge is above the Tab bar. Warn (DEFAULT) when no name exceeds 15 characters or a count reads "0".
- `R-7-32` [MUST] **Copy characters.** Why: writing rules. Applies to: text nodes. Check: no U+2014, U+2013 or U+00B7; no emoji outside a post body.
- `R-7-33` [MUST] **Clipping, buttons and price terms.** Why: R-3-12, R-2-7, R-2-10. Applies to: text and buttons. Check: fixed-height text height >= fontSize * lineHeight; controls in one row share a height; on /paywall|checkout/ boards a currency amount sits within 120 pt above the primary and no price text contains "*". Warn (DEFAULT) when a primary button is outside 44 to 52 tall.
- `R-7-34` [MUST] **Paywall close.** Why: R-2-7. Applies to: boards named /paywall/. Check: an icon button named /close/ >= 44 x 44 with y < 120.
- `R-7-35` [DEFAULT] **Choice counts.** Why: R-1-4, R-1-5. Applies to: frames named /plans|options|choices/. Check: <= 3 children on paywalls, <= 6 on surveys, exactly one selected.
- `R-7-36` [DEFAULT] **Form chunking.** Why: R-1-13. Applies to: boards named /onboarding|checkout|form|signup/. Check: <= 3 nodes named /input|field/ per board unless grouped under titled sections.
- `R-7-37` [DEFAULT] **Rails cut at the edge.** Why: R-1-17. Applies to: horizontal frames named /rail|stories|carousel/ with clip on. Check: content width exceeds the frame and the last visible child crosses the right edge.
- `R-7-38` [DEFAULT] **Primary reach.** Why: R-1-2. Applies to: boards named /onboarding|paywall|checkout|permission/. Check: the primary's bottom edge is in the lower half.
- `R-7-39` [MUST] **Sponsored label.** Why: R-1-20, R-6-9. Applies to: Post nodes named /sponsored|ad/. Check: contains a text "Sponsored"; at most 1 per 5 posts.
- `R-7-40` [DEFAULT] **Component states.** Why: R-1-15, R-4-6, R-4-7. Applies to: components. Check: the state lists in R-4-6 exist as variants; like, save, follow and toggle on and off variants differ in icon name or label (MUST when those variants exist).
- `R-7-41` [MUST] **Icon meanings.** Why: R-1-6, R-4-13. Applies to: nodes named /like|comment|share|save|search|home|back|close|more|profile/. Check: the icon matches the map in R-4-13 (either library's equivalent).
- `R-7-42` [MUST] **Hidden layers.** Why: R-5-9. Applies to: all nodes. Check: no node with enabled false or opacity 0; no empty frame without fill unless named /spacer/; nothing fully outside its board.
- `R-7-43` [DEFAULT] **Media ratio and placeholders.** Why: R-3-15, R-5-8. Applies to: nodes named /media|photo|image|video/ in Post. Check: width/height within 1 percent of 16/9, 4/3, 1/1, 4/5 or 9/16; full-width media equals the board width; no icon child inside a media box (MUST). When the task names an image pack, every node named /avatar|photo|media|story/ that is not text has an image fill (MUST).
- `R-7-44` [MUST] **Privacy words.** Why: R-5-7. Applies to: text nodes. Check: no text matches the private words list.
- `R-7-45` [MUST] **Button build and copy.** Why: R-4-9, R-4-10. Applies to: frames named /button/ with a text child. Check: layout horizontal; justifyContent center; alignItems center; left padding equals right padding, and top equals bottom unless the height is fixed; no child with absolute position or x/y offset; label lineHeight 1, one line, at most 3 words; no icon child unless named /logo|lock|brand/; a label of 2 or more words starts with a verb (follow, find, try, add, share, invite, get, see, save, post, send, allow, continue, retry, start, edit, message, join, buy, pay, turn, open, view).
- `R-7-46` [MUST] **Action row alignment.** Why: R-6-3. Applies to: frames named /action bar|action row|actions/. Check: layout horizontal and alignItems center; one gap value between actions within 1 pt; each action frame has alignItems center, width fit_content and the same icon-to-count gap; icons share one size; the first icon's absolute left edge equals the left edge of the post's body text within 1 pt; the last icon's right edge equals the body text's right edge within 1 pt; across all Posts on a board the first icon's left edge is the same, and every Action bar is an instance of one component with no padding or gap overrides.
- `R-7-47` [DEFAULT] **Wordmark.** Why: R-3-18. Applies to: text named /wordmark|logo/ in a Top bar. Check: fontSize 22 to 26 (never > 28, MUST) and fontWeight 600 to 700 (never >= 800, MUST).
- `R-7-48` [MUST] **Your story.** Why: R-6-10. Applies to: frames named /stories|story rail/. Check: the first child is named /your story/ and contains a node named /plus|add|badge/.
- `R-7-49` [MUST] **Design system board.** Why: R-4-15. Applies to: files with 2 or more screen boards. Check: a board named /design system|components/ exists and holds every component that screens reference.
- `R-7-50` [MUST] **Status bar.** Why: R-3-20. Applies to: iPhone boards. Check: a node named /status bar/ at y 0, height 54 (44 on 812), full board width; a text "9:41" at fontSize 17, weight 600; it is an instance of the Canvas status bar component when the file offers one.
- `R-7-51` [MUST] **Store badges and mobile alignment.** Why: R-6-12. Applies to: website boards. Check: nodes named /app store|google play|badge/ are image fills of the official badge, not drawn frames; on boards 393 wide, headings and text under 120 characters in hero and section headers have textAlign center.
