# CP trains — a pi cockpit module

Train tickets on CP (Comboios de Portugal, cp.pt) with the **Passe Ferroviário Verde**:

- **how long the pass has left** (days, and hours on its last day), in the panel and the status bar;
- **favourite routes**;
- **bookings scheduled for the moment CP opens them** (24 hours before departure with the pass): 5 minutes before, a notification; at the opening, the booking is handed to pi, which buys it in pi cockpit's Browser panel.

This is a proof of concept of the **attended** mode: you are at the computer. pi signs in only as far as you do (you type your own password), stops for your yes before the final confirm, and stops on its own if the total is not the one you expected. The goal is unattended booking; what that needs is under [Towards unattended](#towards-unattended).

## Install

A module of your own: put this folder in your tools folder (**Tools ▸ Open my tools folder**), or **Install** its git URL in the Tools panel, then **Rescan** and allow it. The consent dialog lists what it asks for: notifications, the status bar, typing at pi's prompt (`pi.insert`), **sending pi prompts** (`pi.send`, which the app asks about with an extra warning: that is how a booking is handed to pi at its moment), pi's commands to its panel, and a pi extension.

Its server starts with the app (`"start": "launch"`), so bookings fire while the panel is closed.

## Using it

1. **The pass.** In the panel, set its first day and period (30, 60 or 90 days), or its last day, and your Cartão CP number. Or press **Read it from myCP with pi…**: a request is typed at pi's prompt (you press Enter) for pi to open your myCP wallet (*A minha carteira* ▸ your Cartão CP Digital) in the Browser panel, where you sign in yourself, and keep the dates and the card number it reads.
2. **A booking.** Under **New booking**: stations, date, departure time, the train (optional), passengers, class, the pass, and the total you expect (0 € with the pass). The panel shows when CP opens it. **Schedule** is your approval.
   pi can propose a booking too (`tool_cp_trains_booking_propose`): it waits, marked *waiting-approval*, until you press **Approve** in the panel. pi cannot schedule one on its own.
3. **At its moment** (keep pi cockpit open with a pi tab running, the computer awake, and **pi drives the browser** on under Safety):
   - 5 minutes before: a notification. Sign in to cp.pt in the Browser panel if you are not.
   - At the opening: pi gets the booking and follows its steps: opens the search, picks the train, Comprar, the pass as ticket type, checks the total, asks you in chat, and confirms (the app's own **Allow once** question comes on top). It reports the reference, and the panel shows it.
   - **Run now** hands a scheduled booking to pi at once (when CP's window is already open).
4. **What can go wrong is said:** pi cannot be reached (no pi tab) → *failed*, with the reason, and a notification; the moment passed with the app closed → *missed*; the total was not the expected one, a CAPTCHA, the pass not offered → pi stops and reports *stopped*.

## The rules pi follows

- Only the Browser panel, on cp.pt and CP's own sign-in and payment pages. **Never CP's internal API** (it is not offered to anyone else; the module builds only cp.pt's own search address).
- **Never** a password, a code, card details or an identity document number (the app's browser tools refuse the first three anyway). You sign in yourself, your profile fills in your document, and you pay on CP's own page (with the pass the total is 0 €).
- CP's terms box is ticked only for a booking you scheduled or approved yourself.
- Everything inside CP's 15 minutes; if they run out, once more from the start.
- No CAPTCHA or bot-check bypass: pi stops and hands over.
- The total must be exactly the expected one, and pi asks for your yes in chat before the final confirm.
- Not open yet or sold out: three more looks, 30 seconds apart, then it reports *failed*. No hammering.

## pi's tools

| Tool | |
|---|---|
| `tool_cp_trains_stations` | known stations (name, CP code), or find one |
| `tool_cp_trains_station_learn` | teach the stations of a cp.pt results address |
| `tool_cp_trains_search_link` | the cp.pt address of the trains between two stations on a day |
| `tool_cp_trains_favourites`, `tool_cp_trains_favourite_add` | favourite routes |
| `tool_cp_trains_pass`, `tool_cp_trains_pass_set` | the pass's dates and time left (`source`: `manual` or `mycp`) |
| `tool_cp_trains_bookings` | bookings and what became of them |
| `tool_cp_trains_booking_propose` | propose a booking (waits for your Approve) |
| `tool_cp_trains_booking_steps` | the steps and rules for a started booking |
| `tool_cp_trains_booking_report` | booked / failed / stopped, with the reference and total |

## What it keeps, and where

One file, `cp-trains.json`, in the module's data folder (`<pi cockpit data>/tool-data/cp-trains/`): the pass's dates, favourites, bookings with their history, and stations learned. **No password, no card, nothing of payment**: the module never has them. Your cp.pt sign-in lives in the Browser panel's own cookies (on Windows under `%LOCALAPPDATA%\pi-cockpit`), as for any site you use there.

Station codes: only Lisboa Oriente (`94-31039`) and Porto Campanhã (`94-2006`) are built in (seen on cp.pt). Teach others by searching once on cp.pt and giving pi the results address (`tool_cp_trains_station_learn`).

Times are this computer's clock (Portugal).

## Tests

```bash
npm test
```

They never touch cp.pt or a real profile: temporary data folders, a stand-in for pi and for the app's API, and a **fake CP site** (`test/fake-cp/server.mjs`: results → Comprar → sign-in → ticket type → confirm → reference, plain forms, nothing real).

To watch pi run a booking against the fake site, in an **isolated** pi cockpit run (never your real profile): start `node test/fake-cp/server.mjs`, start the app with `CP_TRAINS_SITE=http://127.0.0.1:<port>` in its environment, and Run now a booking. The override takes only a `http://127.0.0.1:<port>` origin; anything else is ignored.

## cp.pt's checkout, as walked on 2026-11-08

Signed in, with the pass, stopped before the last button (pi's steps follow exactly this, `lib/steps.mjs`; the fake site copies it):

1. Results: **Selecionar ida das HH:MM às HH:MM**, then **Comprar esta viagem**. A dialog, *Viagens selecionadas*, shows the full fare as *Preço indicativo* and one box, **Aceitar termos e condições enumerados de seguida** (CP's sale conditions, terms and privacy policy, over 16), then **Avançar para compra**. Your **Schedule** (or **Approve**) in the panel is your acceptance for that purchase; pi ticks the box only for a booking that has it.
2. No seats or cannot start: `/pt/sem-lugares`, *Não foi possível iniciar o processo de compra*. pi tries again (3 times, 30 s apart).
3. `/pt/compra-online`, with **15 minutes** to finish (*Tempo para comprar*), in three steps:
   1. *Dados dos passageiros*: name, email, phone, NIF and the identity document come from your myCP profile (add the document there: pi never types one). **Desconto** starts on *Inteiro*: pi sets **Passe Ferroviário Verde**, which adds **Informação adicional**, your **Cartão CP number** (kept with the pass; it is printed on the card).
   2. *Reserva de lugares*: CP picks a seat. To choose: **Alterar lugares**, a carriage (*Carruagem 24, 60% lotação*; a full one says *lotada*), a seat *disponível*, **Guardar novos lugares**. A booking keeps CP's seat or takes the emptiest carriage, with an optional wish ("with a socket"). *Total a pagar* shows **0,00 €** with the pass.
   A dialog, *Confirme os dados da reserva antes de avançar*: trip, seat, *Descontos aplicados: Passe Ferroviário Verde*, total, and **Avançar para pagamento** (it does not pay: it opens the last step).
   3. *Pagamento*: ticket delivery and billing details from your profile, *Total a pagar*. At **0,00 € there is no payment method at all**, only **Cancelar** / **Confirmar**. pi stops if any payment method shows up.
4. **Confirmar** → `/pt/sucesso-bilhetes`, *Compra realizada com sucesso*, tickets by email. **Ver viagens** → *As minhas viagens* → the trip's page `/pt/mycp/viagens/<id>/detalhes` (*Nº Comboio*, *Carruagem*, *Lugares*, *Estado: Confirmado*, *Preço total*, and **Pedir reembolso** / **Trocar viagem** / **Ver bilhete**). pi reports the trip id, train, carriage and seat.

Bought this way once, for real, on 2026-11-08: IC 621, Lisboa Oriente 11:39 → Porto Campanhã, carriage 24 seat 42, 0,00 €.

Your pass is on myCP › *A minha carteira* › the Cartão CP Digital › *Títulos no cartão* ("Passe Ferroviário Verde Digital 30 — 01/12/2026 até 30/12/2026"), with the card number above it. The Green Pass is taken on Intercidades.

## Not known yet

- The exact rule of the pass's window (is a train 25 h away refused?). It is a setting per booking (`openHoursBefore`, 24 by default).
- How long a cp.pt sign-in lasts. Its sign-in page has **no "remember me"**.

## Readiness check and unattended bookings

**30 minutes before the opening** (or when you press **Check now**), the module checks what it can see itself (the pass covers the day, the card number is kept, CP's terms accepted for the booking) and asks pi to open myCP and confirm you are signed in, with **pi drives the browser** on and cp.pt allowed. pi answers with `tool_cp_trains_readiness_report`; the panel shows the answer, and you get a notification when something is wrong, or when pi did not answer within 5 minutes. Nothing is bought.

**Unattended** (a box in the booking form, yours only: pi's proposals never are): pi does not wait for a yes in chat before **Confirmar**; your Schedule was that yes. Every other rule stands (exactly the expected total, no payment method, no CAPTCHA, stop on any doubt), and the app's own **Allow once** questions still come: until pi cockpit can take a pre-approval for one booking, someone has to press them.

**Locked screen: works.** Tested 2026-11-08 with `test-probe/locked-screen.probe.mjs`: pi cockpit's real browser tools, driven by its fake pi in a throwaway profile, bought a fake ticket end to end (52 steps, screenshot included) with Windows locked the whole time. To run it (never your real profile; it needs a pi cockpit development checkout):

```bash
PI_COCKPIT_DIR=/path/to/pi-cockpit WAIT_BEFORE_S=60 node --test test-probe/locked-screen.probe.mjs
```

## Towards unattended

What stands between this and booking at 3 a.m. with nobody there:

1. **Signing in.** CP signs you out after a few minutes, and pi never types passwords. Planned: an app feature that fills a login kept in the OS's protected store (Electron safeStorage, Windows Credential Manager) on one exact sign-in page, the way a password manager does, without pi ever seeing it. Not a plain file.
2. **The final confirm.** The app asks **Allow once** before a buy/confirm click. Planned: a one-off approval you create when you schedule: one site, one train, a 15-minute window, only when the page shows the expected total, used once. Not the Test sites list, which would turn off every confirmation on cp.pt for good.
3. **The computer awake** at that moment (a Windows wake timer).

Both app features belong to pi cockpit itself, with their own docs and tests.
