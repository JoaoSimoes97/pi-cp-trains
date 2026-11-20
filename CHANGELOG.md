# Changelog

## 0.3.0

- **Allow paying up to X € (needs pi cockpit 0.19).** A booking from the panel can carry the most it may cost (`payUpTo`, 0 to 500 €, at least the expected total; pi's proposals never carry one). When it is scheduled, the module asks pi cockpit for a payment allowance (`browser.pay.request` for cp.pt, that amount, the booking, until its last start), which pi cockpit confirms with you in its own dialog; the booking shows the answer. At the opening it is armed for the pi tab the booking went to (`browser.pay.arm`, with the `piId` that `pi.send` answers), ended at the result (`browser.pay.disarm`), revoked when the booking is cancelled or removed. pi's rules then allow a way to pay that CP already shows selected and saved, with the expected total; choosing or filling one still stops. The manifest asks for `browser.pay`, which pi cockpit before 0.19 does not know: it refuses the module there (stay on 0.2.0 with an older pi cockpit). A call that pi cockpit does not answer (an older one) leaves the booking as before, and says so.
- The module's API calls take a wait of their own (`call(method, params, { wait })`): the allowance's question waits up to 10 minutes for your answer.
- Tests: `test/allowance.test.mjs` (the amount, the request, an older pi cockpit, arming, ending), `test/server.test.mjs` (the form's field end to end without the API).

## 0.2.0

- **A booking's result reaches you, and waits for you.** pi's report (*booked* with CP's reference and total, *failed*, *stopped*) was kept in the panel but never notified; now every end of a booking, *missed* included, is one notification (each said once, also when the clock looks twice), and stays in the panel and the status bar ("CP: 1 result to see") until you press **Seen** or **All seen**. Results to see come first in the list, with their outcome and time. Results kept before 0.2.0 count as seen.
- **A booking pi never reported on ends as "no report".** A started booking with no report 45 minutes after it was handed to pi (or by the train's departure, if sooner) is *failed*, "no report", with the likely reason: pi cockpit was not running then, the computer was asleep (no check for N minutes), or pi stopped, its tab was closed, or it is stuck. Before, it stayed *started* for ever. A late report from pi replaces it, and is notified again. *Missed* says the likely reason the same way.
- With pi cockpit 0.19.0 or later, a result's notification (and "did not start") stays on screen until you dismiss it (`notify { persistent: true }`); older versions show it as before.
- `tool_cp_trains_booking_report` says the user is told; the panel's server takes `result-seen` and `results-seen`.
- Tests: `test/scheduler.test.mjs` (notified once, titles, no report after 45 min and after a sleep, missed while closed, pi not reachable not said twice, old results), `test/extension.test.mjs` (a late report), `test/server.test.mjs` (Seen, All seen).

## 0.1.0

- The module: the pass's time left, favourites, bookings handed to pi at CP's opening, the readiness check, unattended bookings with pi cockpit's site trust and saved sign-ins, the fake CP site for tests.
