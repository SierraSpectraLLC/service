# Writing a "What's new in Baseline" batch

The What's-new cards live in one file in this repository. There is no admin
screen: an entry ships like any other change, by editing the file and pushing.
Vercel deploys it, and every user who hasn't dismissed the batch sees the
cards once, on the dashboard, the next time they load it.

## The one file

`src/lib/whatsNew.ts` - look for `WHATS_NEW`. Entries go **at the top of the
list** (newest first). A commented-out template sits in the file ready to copy.

```ts
{
  key: "2026-09-01-kit-builder",
  date: "2026-09-01",
  title: "Build PM kits from the parts book",
  body: "Pick the parts once, name the kit, and every schedule that uses it pulls the whole list. No more retyping the seal set.",
  image: "/whatsnew/kit-builder.png",
  href: "/settings/parts",
  audience: "staff",
},
```

Field by field:

| Field | Rules |
| --- | --- |
| `key` | Unique, permanent. Date plus a slug (`"2026-09-01-kit-builder"`) is the convention. **Never reuse or rename a key** - it is what each user's "seen" marker points at. A duplicate key breaks everyone's markers, and a test fails the build if you make one. |
| `date` | `YYYY-MM-DD`, the day it shipped. Shown on the card. Entries must stay newest-first - also enforced by a test. |
| `title` | One line naming the change. |
| `body` | Two or three sentences, benefit first: what can the reader do now that they couldn't? Plain text only. |
| `image` | Optional. `"/whatsnew/<name>.png"` - see below. |
| `href` | Optional. An in-app path; renders as a "Take a look →" link. |
| `audience` | `"all"` = everyone including clients. `"staff"` = engineers and you, never clients. `"owner"` = you alone. When in doubt use `"staff"` - clients should only get `"all"` cards about things they can actually see. |

## Photos

1. Take the screenshot. A normal browser screenshot of the real page is
   perfect (Cmd-Shift-4 on a Mac, Snipping Tool on Windows). Crop to the one
   card or region the entry is about - not the whole window, and mind what
   else is in frame: real client names are fine for staff cards, but an
   `audience: "all"` card is seen by every client, so its screenshot must not
   show another client's data.
2. Shape it wide: the card window is about **2.3:1** (1120 x 480 works well).
   Much wider or taller and the card crops it from the top-center.
3. Save as PNG into **`public/whatsnew/`** with a short name:
   `public/whatsnew/kit-builder.png`.
4. Reference it in the entry as `image: "/whatsnew/kit-builder.png"` - the
   leading `/whatsnew/` matters, `public` itself is not part of the path.

Screenshots in that folder sit behind the login wall like the pages they
depict; nothing leaks to the open web.

## Shipping it

Commit the edited `whatsNew.ts` and the new PNGs together and push. That's
all - the deploy does the rest. If you'd rather not touch the code, the other
path works exactly as well: tell Claude what shipped and what the cards
should say, and it lands in the same file the same way.

## How showing/dismissing behaves (so you can predict it)

- Each user sees a card **once**. Dismissing anywhere (button, backdrop,
  Escape) marks the whole current batch seen for that account, on every
  device.
- New entries added later show only themselves - never re-show old ones.
- Clients only ever see `"all"` cards; their dismissal still advances past
  staff cards they were never shown.
- The overlay never appears while you are in "View as" - impersonation would
  otherwise burn your own unseen batch.
- Everything ever published stays readable at **avatar menu → What's new**.
- An empty `WHATS_NEW` list (like right now) means no overlay for anyone and
  "Nothing yet." on the What's-new page.

## Checks that protect you

`tests/whatsNew.test.ts` fails the build on duplicate keys, out-of-order
dates, malformed dates, or an image path outside `/whatsnew/`. If your push
fails CI after editing entries, it is almost certainly one of those four.
