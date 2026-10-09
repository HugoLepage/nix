# Firebase Realtime Database

Nix talks to `https://astro-nix-default-rtdb.europe-west1.firebasedatabase.app` over REST, without Firebase Auth.
`database.rules.json` holds the security rules. They only take effect once published.

> **The 30-level update needs the rules re-published.** The rules written for three levels cap `unlocked` at 4,
> `last` at 3 and only accept the best times `l1`–`l3`. Until the new `database.rules.json` is published, the
> database refuses a player's saves from the moment they start level 4. Clearing level 3 itself still saves, so a
> level-3 save that goes through does not show the new rules are live. Nothing is lost: the progress stays in that
> device's cache and is sent again on the next save, `online` event or visit, so it reaches the database once the
> new rules are live. Existing saves are valid under the new rules as they are.

## Data

```
/users/<key>     = { name, salt, iter, verifier, created }      key = lower-cased username
/saves/<secret>  = { unlocked, last?, best?: { l1?, l2?, …, l30? } }
```

One PBKDF2 run over the password gives a derived key, and two labelled SHA-256 hashes of it give the `verifier`
and the `secret` (see `src/scripts/auth.js`). The verifier is public and proves the password at sign-in. The secret
is never stored remotely. Only someone who knows the password can work out where a player's save is.

## What the rules enforce

- Nothing can be listed. `/users`, `/saves` and the root cannot be read as a whole. Single records can be read by
  their key (needed to sign in) and single saves by their secret.
- Accounts are create-only: a record can be written once, with exactly the five fields in the right formats
  (`iter` must be 150000). It can never be changed or deleted.
- A save can only be written at a 64-hex path. It must always hold `unlocked` (an integer from 1 to 31 that can
  never go down; 31 means all 30 levels are cleared), plus an optional `last` (an integer from 1 to 30) and `best`
  times, each in (0, 86400] seconds. One `$level` rule covers every best time: its key must match `l1`–`l9`,
  `l10`–`l29` or be `l30` (no leading zeros, nothing past 30). Saves cannot be deleted, and any other key is
  refused.

Some risks remain, because rules cannot fix them without Firebase Auth:

- Anyone can read a record and run an offline password guess against its verifier. The cost is one PBKDF2 run
  (150k iterations) per guess.
- Accounts and saves can be created without limit, and names can be squatted.
- Anyone who knows a player's password, or has their session from the device's localStorage, can edit that
  player's save within the rules (`unlocked` can still only go up).

The values `150000`, `31`, `30` and the `l1`–`l30` key patterns match `ITERATIONS` in `auth.js` and
`LEVEL_COUNT` in `config.js` (`unlocked` goes up to `LEVEL_COUNT + 1`). If you change those, update the rules too,
then publish them.

## Publishing

1. Firebase console → Realtime Database → **Data**: delete any old v1 records, the ones under `/users` that have
   `hash` or `progress`. The client no longer accepts them, so those names show the username error until the
   records are gone. Then the players can sign up again. Do not convert v1 records to the new format: their `hash`
   was public and equals the new derived key, so anyone could work out a converted account's save path.
2. Realtime Database → **Rules**: paste `database.rules.json`, run the Playground cases below, then click
   **Publish**. Do this again whenever `database.rules.json` changes (it last did for the 30-level update).
3. Check from a shell: `curl -i "<DB>/users.json"` and `curl -i "<DB>/saves.json?shallow=true"` must both return
   `401 Permission denied`.
4. Check that a failed conditional write does not leak data. Saves stay private only because `/saves` cannot be
   listed, and Firebase does not document whether the rules also cover the body of a `412` (ETag mismatch) reply.
   - **Data**: add `/canary = {"secret":"x"}` (the console bypasses the rules).
   - `curl -i "<DB>/canary.json"` must return `401`.
   - `curl -i -X PUT -H "if-match: null_etag" -d '"probe"' "<DB>/canary.json"` must return `401`. A `412` with
     `{"secret":"x"}` in its body means conditional writes disclose data the rules hide: the same request on
     `/saves.json` would list every save, so saves would not be private. Rules cannot fix that; add it to the risks
     above.
   - Delete `/canary`. The probe writes nothing either way: the root is not writable and `null_etag` never matches
     an existing node.

## Rules Playground cases (Authenticated off)

Setup:

- `EXISTING`: a real account key.
- `SAVE`: an existing save with `unlocked` ≥ 2. Note its `unlocked` as U. If `/saves` is empty (right after step 1,
  say), add one by hand in the **Data** tab, for example `/saves/<"cd" repeated 32 times> = {"unlocked":2}`, and
  delete it after the cases.
- `FRESH`: 64 hex characters that are not in use, for example `ab` repeated 32 times.
- `VALID`: `{"name":"ZZ_Probe","salt":"<32 hex>","iter":150000,"verifier":"<64 hex>","created":1759000000000}`

| # | Type | Location | Data | Expect |
|---|---|---|---|---|
| 1 | read | `/users/EXISTING` | – | Allow |
| 2 | read | `/users` | – | Deny |
| 3 | read | `/saves` | – | Deny |
| 4 | set | `/users/zz_probe` | `VALID` | Allow |
| 5 | set | `/users/zz_probe` | `VALID` with `"admin":true` added | Deny |
| 6 | set | `/users/zz_probe` | `VALID` with `"name":"Other"` | Deny |
| 7 | set | `/users/zz_probe` | `VALID` with `"iter":1` | Deny |
| 8 | set | `/users/zz_probe/name` | `"ZZ_Probe"` (half record) | Deny |
| 9 | set | `/users/EXISTING` | a valid record named after EXISTING | Deny |
| 10 | set | `/users/EXISTING` | `null` | Deny |
| 11 | set | `/saves/FRESH` | `{"unlocked":1,"last":1}` | Allow |
| 12 | update | `/saves/FRESH` | `{"last":1}` (no `unlocked`) | Deny |
| 13 | update | `/saves/SAVE` | `{"unlocked":31,"last":30,"best":{"l1":12.3,"l9":40,"l10":55.5,"l30":95.2}}` | Allow |
| 14 | update | `/saves/SAVE` | `{"unlocked": U-1}` | Deny |
| 15 | update | `/saves/SAVE` | `{"best":{"l31":10}}`, `{"best":{"l05":10}}`, `{"best":{"l0":10}}` or `{"best":{"l1":0}}` | Deny |
| 16 | update | `/saves/SAVE` | `{"unlocked":32}`, `{"last":31}`, `{"last":0}` or `{"foo":1}` | Deny |
| 17 | set | `/saves/SAVE` | `null` | Deny |
| 18 | set | `/saves/not-hex` | `{"unlocked":1}` | Deny |
| 19 | set | `/foo` | `"x"` | Deny |
