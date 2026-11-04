# Styles

One stylesheet per area of the page. `dashboard.html` loads them in this
order, and **the order matters**: when two rules are equally specific, the
later file wins.

| File | What it styles |
|---|---|
| `base.css` | Colour tokens for light and dark, the reset and page frame, icons, and the buttons, cards and text helpers every tab uses. Start here to change a colour. |
| `topbar.css` | The sticky top bar (connection, refresh, theme, emergency stop), the alert bars under it, the page header, the status banner, the tabs and the footer. |
| `overview.css` | The Overview tab: battery and computer tiles, subsystems, ROS graph, camera card, and the LiDAR card, including the Detailed view's radar panel and beam select. |
| `drive.css` | The Drive tab's own cards (arm, pad, camera HUD, who's driving, vitals, limits) and the unlock dialogs. They sit hidden under the driving view and hold the driving state, so they are still styled. |
| `advanced.css` | The Advanced tab: needs attention, robot system, nodes, diagnostics, topics, checks, warnings log. |
| `controller.css` | The Controller tab: the drawing of the PS4 controller, what is pressed, the raw `/joy` chips and Map buttons. |
| `cockpit.css` | The driving view (`js/cockpit.js`), on the Drive tab and in full screen: its top bar, panes, floating controls, LiDAR and warning, Settings, thumb sticks, speedometer, the side rail and the Record buttons. |

Each file starts with a numbered list of its sections, and each section
has a matching heading. Search for a section's number and name to jump
to it.

## Where to put a new rule

- Put it in the file for the part of the page it styles, in the section
  it belongs to.
- Phone and narrow-screen versions of a rule sit in that same section,
  inside its `@media` block.
- A rule that styles several areas at once goes under "Shared by several
  areas" in `base.css`.
- Some sections hold a rule that looks like it belongs elsewhere. That is
  on purpose: it overrides a rule above it, so it has to stay after it.
  Moving it would change how the page looks.

The canvas plots (the LiDAR maps, the radar) are drawn in JavaScript, so
their colours live in the JS, not here. The radar's are in the config
block at the top of `js/radar.js`.
