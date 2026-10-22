# Run of Show

One live timeline for an event. The planner runs the day from one screen; each vendor
(DJ, MC, caterer, photographer…) gets a private link that shows only their cues, lets
them check in on arrival and mark cues done, and pings them when their times change.

## Run it

```sh
npm install
npm start            # http://localhost:3000
npm test
```

Needs Node 22.13+ (uses the built-in `node:sqlite`). Copy `.env.example` to set things up;
everything works without any keys.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/damiilolagrey-gif/runofshow)

`render.yaml` sets up a Starter web service with a 1 GB disk for the SQLite database and
push keys. Add the `WHATSAPP_*` variables from `.env.example` in the Render dashboard
when you have Meta Cloud API access.

## How it works

- **Create an event** at `/` from a template: Nigerian wedding reception (13 vendors,
  16 cues), corporate event, conference, or blank.
- **Planner screen** at `/p/<planner-token>`: live timeline, who's checked in, what's
  overdue, and an activity feed. "Running late…" or "Move…" on a cue pushes it and every
  unfinished cue after it by any number of minutes, then messages each affected vendor
  once with their new times.
- **Vendor screen** at `/v/<vendor-token>`: no signup. Check in, see the next cue with a
  countdown, mark cues done. Opens and works offline (check-ins and done marks queue
  until the signal is back).
- **Notifications**, per vendor, on every channel they have:
  - browser push (vendor taps "Turn on alerts"),
  - WhatsApp via the Meta Cloud API when `WHATSAPP_*` is set,
  - otherwise logged in the activity feed with a one-tap "Send on WhatsApp" link for the planner.
- **Guests** (`/p/<token>/guests`): paste a list from Excel, send each guest a WhatsApp
  invite link with RSVP and a QR entry pass, or share one open RSVP link in family groups.
- **Usher gate** (`/gate/<gate-token>`): ushers scan QR passes with their phone camera (or
  type the 6-letter code / search a name). Shows table number, flags duplicates, live headcount.
- **Aso-ebi** (`/p/<token>/asoebi`): list items with sizes or colours; buyers order from the
  public page (`/e/<public-token>`), pay by bank transfer (planner marks paid) or by card via
  Paystack when `PAYSTACK_SECRET_KEY` is set; track paid and collected.
- **Payments & budget** (`/p/<token>/money`): each vendor's fee, agreement text (vendor taps
  Accept on their page), deposits and balances with due dates; budget lines that fill in
  automatically from linked vendors.
- **Couple's page** (`/c/<couple-token>`): read-only view of budget, payments, RSVPs,
  aso-ebi and the day's timeline.
- **Accounts and plans** (`/signup`, `/dashboard`, `/pricing`): planners sign up, see all
  their events and pay through Paystack. Starter is free (1 upcoming event, 150 guests per
  event), Pro and Business are monthly or yearly subscriptions, and any single event can be
  unlocked on its own. Limits apply only once `PAYSTACK_SECRET_KEY` is set. Aso-ebi card
  payments settle to the planner's own bank (a Paystack subaccount) minus the platform fee.
  Prices live in env vars (`PRICE_PRO_MONTHLY`, `PRICE_PRO_YEARLY`, `PRICE_BUSINESS_MONTHLY`,
  `PRICE_BUSINESS_YEARLY`, `PRICE_EVENT`, in kobo; `ASOEBI_FEE_PERCENT`). Point Paystack's
  webhook at `/api/paystack/webhook` so renewals and cancellations are picked up.
- **Preview a time**: add `?clock=17:40` to either URL to see the day as it would look then.

The links are the credentials: anyone with the planner link can edit the event, and a
vendor link only exposes that vendor's cues.

## Layout

```
server/
  app.js        HTTP routes + Socket.IO rooms (planner:<event>, vendor:<id>)
  store.js      SQLite data access and the timeline rules (shift, done, check-in)
  notify.js     turns changes into one message per vendor; push + WhatsApp senders
  templates.js  starter timelines
public/         plain HTML/JS, no build step; sw.js is the offline cache + push handler
test/           node:test API and socket tests
```

## Not in the MVP yet

Seating charts, password reset by email, planner teams and logos, venues with multiple planners, editing templates in the UI,
SMS fallback, and multi-day events.
