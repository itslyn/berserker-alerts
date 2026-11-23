# Berserker Alerts

TERA Toolbox QOL mod for berserker (Asura private server). Provides local combat reminders and optional announcements on cooldowns in party chat.

## Features

- Auto-detection of whether you are in tank or dps stance.
- Only notifies when you are in combat.

### Personal alerts (tank/dps)

| Stance | Alerts |
|---|---|
| Tank (Intimidation) | Punishing Strike, Raging Fury, Flurry of Blows |
| DPS | Flurry of Blows |

- On by default.
- There is a 3 second grace period when starting combat before notices show up so you don't get spammed with notices while starting the boss.
- When there's 3 seconds left on the buff/debuff, a notice will appear on the bottom of the screen warning you.
- When the buff/debuff drops, a TTS voice will notify you to use it again.

### Optional party chat alerts (tank only)

| Trigger | Message |
|---|---|
| Bloodlust activated | `Bloodlust popped!` |
| Bloodlust cooldown reaches 10 seconds | `Bloodlust up in 10 seconds!` |
| Inescapable Doom activated | `Enrage popped!` |
| Inescapable Doom cooldown reaches 10 seconds | `Enrage up in 10 seconds!` |

- Off by default. Use the command to turn it on (only needed to turn it on once and it'll save in your config).
- The alerts will be sent via party chat.

## Commands

Use the commands in the `/8` toolbox chat or pre-fix them with `!`.

| Command | Action |
|---|---|
| `zerk` | Show command help |
| `zerk alerts` | Toggle personal alerts |
| `zerk alerts on` / `off` | Set personal alerts |
| `zerk party` | Toggle party-chat announcements |
| `zerk party on` / `off` | Set party-chat announcements |
| `zerk status` | Show alerts, stance, buffs, and current boss debuff |
| `zerk party status` | Show party toggle, IDs, and tracked cooldowns |
| `zerk stance` | Show detected tank/DPS stance |
| `zerk buffs` | Show tracked self-buff status |


## Installation 

- Place in your mods folder in your TERA Toolbox.

If you have any issues with this, feel free to let me know on Discord: @itslyn

GitHub: https://github.com/itslyn/berserker-alerts
