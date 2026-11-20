# Changelog

## 0.2.0

- **A booking's result reaches you, and waits for you.** pi's report (*booked* with CP's reference and total, *failed*, *stopped*) was kept in the panel but never notified; now every end of a booking, *missed* included, is one notification (each said once, also when the clock looks twice), and stays in the panel and the status bar ("CP: 1 result to see") until you press **Seen** or **All seen**. Results to see come first in the list, with their outcome and time. Results kept before 0.2.0 count as seen.
- **A booking pi never reported on ends as "no report".** A started booking with no report 45 minutes after it was handed to pi (or by the train's departure, if sooner) is *failed*, "no report", with the likely reason: pi cockpit was not running then, the computer was asleep (no check for N minutes), or pi stopped, its tab was closed, or it is stuck. Before, it stayed *started* for ever. A late report from pi replaces it, and is notified again. *Missed* says the likely reason the same way.
- `tool_cp_trains_booking_report` says the user is told; the panel's server takes `result-seen` and `results-seen`.
- Tests: `test/scheduler.test.mjs` (notified once, titles, no report after 45 min and after a sleep, missed while closed, pi not reachable not said twice, old results), `test/extension.test.mjs` (a late report), `test/server.test.mjs` (Seen, All seen).

## 0.1.0

- The module: the pass's time left, favourites, bookings handed to pi at CP's opening, the readiness check, unattended bookings with pi cockpit's site trust and saved sign-ins, the fake CP site for tests.
