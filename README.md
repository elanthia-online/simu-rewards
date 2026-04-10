# Daily Simutronics Rewards

A GitHub Action created by Ondreian to automate daily logins and monthly SimuCoin redemptions for Simutronics games.

> **Questions?** Open an [issue](https://github.com/elanthia-online/simu-rewards/issues) or reach out on game-related Discord channels.

---

## Setup Instructions

### 1. Create a Private Repository

Go to [github.com/new](https://github.com/new) and create a new **private** repository.

> **Why private?** GitHub automatically disables scheduled workflows in public repos with no activity for 60 days. A private repo avoids this.

![Create new repository](images/create_new_repository.png)

### 2. Add Repository Secrets

Your Simutronics credentials are stored as encrypted [GitHub Secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions) — they are never exposed in logs or code.

Navigate to **Settings → Secrets and variables → Actions**, then click **New repository secret** to add each of the following:

| Secret Name | Value |
|---|---|
| `ACCOUNT1` | Your Simutronics account name |
| `PASSWORD1` | Your Simutronics password |
| `GAMECODE1` | A game code from the table below *(optional — defaults to `GS3`)* |

Repeat for each additional account, incrementing the number (`ACCOUNT2` / `PASSWORD2` / `GAMECODE2`, etc.).

#### Game Codes

| Code | Game |
|---|---|
| `GS3` | GemStone IV Prime |
| `GST` | GemStone IV Test |
| `GSX` | GemStone IV Platinum |
| `GSF` | GemStone IV Shattered |
| `DR` | DragonRealms Prime |
| `DRT` | DragonRealms Test |
| `DRX` | DragonRealms Platinum |
| `DRF` | DragonRealms Fallen |

### 3. Create the Workflow File

From the **Code** tab of your repository, click **Add file → Create new file**.

Name the file `.github/workflows/rewards.yml` — GitHub will automatically expand the directory structure as you type.

![Create new file](images/create_new_file.png)

Paste the following into the file editor, then adjust for your accounts (see the comments in the YAML):

```yaml
# .github/workflows/rewards.yml
name: rewards

on:
  workflow_dispatch:   # allows manual runs from the Actions tab
  schedule:
    # Cron generator: https://crontab.guru/#5_1_*_*_*
    # 01:05 AM UTC = 8:05 PM EST (summer) / 9:05 PM EST (winter)
    # Please stagger your time to spread server load.
    - cron: "5 1 * * *"

jobs:
  login-account:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          # ── Account 1: uses a GAMECODE1 secret ──
          - account: ACCOUNT1
            password: PASSWORD1
            game: GAMECODE1

          # ── Account 2: no game code → defaults to GS3 ──
          - account: ACCOUNT2
            password: PASSWORD2

          # ── Account 3: hardcoded game code (no secret needed) ──
          - account: ACCOUNT3
            password: PASSWORD3
            game: 'GSF'

          # ── Account 4: skip character logins, only redeem SimuCoins ──
          - account: ACCOUNT4
            password: PASSWORD4
            bypass_login: true

      fail-fast: false

    name: login ${{ matrix.account }}
    steps:
      - uses: elanthia-online/simu-rewards@v1
        with:
          account:      ${{ secrets[matrix.account] }}
          password:     ${{ secrets[matrix.password] }}
          game:         ${{ secrets[matrix.game] || matrix.game || 'GS3' }}
          bypass_login: ${{ secrets[matrix.bypass_login] || matrix.bypass_login || 'false' }}
```

Remove or duplicate the `- account: …` blocks in `matrix.include` to match however many accounts you added secrets for in Step 2.

![Create new code](images/create_new_code.png)

Click **Commit changes** to save the file.

### 4. Run It

The workflow will run automatically at the scheduled cron time. To run it immediately, go to **Actions → rewards → Run workflow**.

![Run workflow](images/run_new_workflow.png)

---

## Configuration Reference

### `game`

The game code can be provided three ways (checked in this order):

1. **As a secret** — set a `GAMECODE1` repository secret (most secure, recommended for shared repos)
2. **Hardcoded in the matrix** — e.g. `game: 'GSF'` (simple, visible in the workflow file)
3. **Omitted** — defaults to `GS3`

### `bypass_login`

Set `bypass_login: true` on an account to skip character logins and only process SimuCoin redemptions. This is useful for instance-limited games like Shattered (`GSF`) or Fallen (`DRF`).

### `schedule` (cron)

The `cron` line in the workflow controls when your rewards are collected. **You should change it from the default** to a time that works for you and to help spread the load across Simutronics' servers — if everyone runs at the same minute, it creates unnecessary strain.

A cron expression has five fields:

```
┌───────────── minute (0–59)
│ ┌───────────── hour (0–23)
│ │ ┌───────────── day of month (1–31)
│ │ │ ┌───────────── month (1–12)
│ │ │ │ ┌───────────── day of week (0–6, Sunday = 0)
│ │ │ │ │
* * * * *
```

The default in the example is `"5 1 * * *"`, which means 1:05 AM UTC every day. All GitHub Actions cron times are in **UTC** — use a converter like [dateful.com/time-zone-converter](https://dateful.com/time-zone-converter) if you need to work out your local equivalent.

#### Common examples

| Cron expression | Runs at (UTC) |
|---|---|
| `"5 1 * * *"` | 1:05 AM — the example default |
| `"30 3 * * *"` | 3:30 AM |
| `"0 12 * * *"` | 12:00 PM (noon) |
| `"45 22 * * *"` | 10:45 PM |

**Pick a random-ish minute** (not `:00` or `:30`) so runs are naturally staggered. The hour matters less — just avoid picking the exact same time as the example default.

Use [crontab.guru](https://crontab.guru/) to build and verify your expression before committing.

> **Note:** GitHub does not guarantee cron jobs run at the exact scheduled time. During periods of high demand, runs may be delayed by several minutes or occasionally longer. This is normal and will not cause missed rewards.

---

## Troubleshooting

**Workflow isn't running on schedule** — GitHub may disable scheduled workflows after 60 days of no repository activity. Push a commit or run the workflow manually to re-enable it. Using a private repo reduces (but doesn't eliminate) this risk.

**Login failures** — Double-check that your secret names in the workflow YAML exactly match the secret names you created in Settings. Names are case-sensitive.
