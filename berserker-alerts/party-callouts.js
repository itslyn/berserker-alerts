'use strict';
// Server-reported cooldown tracking and party announcements.
const TEN_SECONDS_MS = 10000;
const SEND_WINDOW_MS = 9000;
const TICK_MS = 250;
const POPPED_CONFIRM_MS = 2500;
const DEFAULT_PARTY_COOLDOWN_IDS = Object.freeze({
    bloodlust: 213100,
    enrage: 200200
});

module.exports = function createPartyCallouts(mod, context) {
    const { config, persist, isBerserker, tankStanceActive, onBloodlustCooldownStart } = context;
    let enabled = config.partyCalloutsEnabled === true;
    let lastCooldownPacket = null;
    let lastMatched = 'none';
    let lastSend = 'none';
    let lastBlocked = 'none';
    const state = { bloodlust: null, enrage: null };
    const settings = {
        bloodlust: {
            idKey: 'partyBloodlustCooldownSkillId',
            name: 'Bloodlust',
            message: 'Bloodlust up in 10 seconds!',
            poppedMessage: 'Bloodlust popped!'
        },
        enrage: {
            idKey: 'partyEnrageCooldownSkillId',
            name: 'Inescapable Doom II',
            message: 'Enrage up in 10 seconds!',
            poppedMessage: 'Enrage popped!'
        }
    };

    const now = () => Date.now();
    const message = text => mod.command.message('[Party Callouts] ' + text);
    const isValidId = id => Number.isSafeInteger(Number(id)) && Number(id) > 0;
    const normalizedId = value => isValidId(value) ? Number(value) : null;
    const effectiveId = key =>
        normalizedId(config[settings[key].idKey]) || DEFAULT_PARTY_COOLDOWN_IDS[key];
    let configNeedsSaving = false;
    for (const key of Object.keys(settings)) {
        const idKey = settings[key].idKey;
        if (!normalizedId(config[idKey])) {
            config[idKey] = DEFAULT_PARTY_COOLDOWN_IDS[key];
            configNeedsSaving = true;
        }
    }
    if (configNeedsSaving) persist();
    const skillIdFrom = event => {
        const value = event && event.skill;
        return normalizedId(value && typeof value === 'object' ? value.id : value);
    };
    const family = id => Math.floor(id / 100);
    const matchingSkill = (incoming, configured) => configured !== null &&
        (incoming === configured || family(incoming) === family(configured));
    const canSend = () => enabled && isBerserker() && tankStanceActive() &&
        !!mod.game.me.inCombat && mod.game.me.alive !== false;
    function reasonNotReady() {
        if (!enabled) return 'party announcements OFF';
        if (!isBerserker()) return 'not Berserker';
        if (!tankStanceActive()) return 'DPS/unknown stance';
        if (!mod.game.me.inCombat) return 'not yet in combat';
        if (mod.game.me.alive === false) return 'dead';
        return null;
    }
    function sendPartyMessage(key, text) {
        const reason = reasonNotReady();
        if (reason) { lastBlocked = key + ': ' + reason; return false; }
        try {
            const accepted = mod.toServer('C_CHAT', 1, { channel: 1, message: text });
            if (accepted === false) {
                lastSend = key + ': Toolbox rejected C_CHAT';
                mod.log('[Party Callouts] ' + lastSend);
                return false;
            }
            lastSend = key + ': handed to Toolbox (' + text + ')';
            return true;
        } catch (error) {
            lastSend = key + ': C_CHAT ERROR ' + error.message;
            mod.error('[Party Callouts] Unable to send party chat: ' + error.message);
            return false;
        }
    }

    function trySendPopped(key, item) {
        if (!item || !item.poppedDueAt) return;
        if (now() > item.poppedDueAt) {
            lastBlocked = key + ': popped message expired; ' + (reasonNotReady() || 'unknown');
            item.poppedDueAt = 0;
            return;
        }
        if (reasonNotReady()) return;
        item.poppedDueAt = 0;
        sendPartyMessage(key, settings[key].poppedMessage);
    }
    // Each new cooldown starts a callout cycle.
    function updateCooldown(event, isStart) {
        if (!isBerserker() || !event) return;
        const id = skillIdFrom(event);
        const milliseconds = Number(event.cooldown);
        if (!id || !Number.isFinite(milliseconds) || milliseconds < 0) return;
        const timestamp = now();
        lastCooldownPacket = { id, milliseconds, isStart, timestamp };

        for (const key of Object.keys(settings)) {
            if (!matchingSkill(id, effectiveId(key))) continue;
            lastMatched = key + ' ID ' + id + ', ' + (isStart ? 'cooldown START' : 'cooldown decrease');
            const previous = state[key];
            const endAt = timestamp + milliseconds;
            if (isStart) {
                const newCycle = !previous || timestamp - previous.startedAt >= 1800;
                if (newCycle) {
                    state[key] = {
                        endAt, startedAt: timestamp,
                        armed: milliseconds > TEN_SECONDS_MS,
                        announced: false,
                        poppedDueAt: milliseconds > 0 && enabled ? timestamp + POPPED_CONFIRM_MS : 0
                    };
                    if (milliseconds > 0) {
                        if (key === 'bloodlust' && typeof onBloodlustCooldownStart === 'function') {
                            try { onBloodlustCooldownStart(id); }
                            catch (error) { mod.error('[Party Callouts] Bloodlust Flurry sync failed: ' + error.message); }
                        }
                        trySendPopped(key, state[key]);
                    }
                } else {
                    previous.endAt = endAt;
                }
            } else if (previous && timestamp < previous.endAt) {
                previous.endAt = endAt;
            } else if (milliseconds > TEN_SECONDS_MS) {
                state[key] = {
                    endAt, startedAt: timestamp,
                    armed: true, announced: false
                };
            }
        }
    }

    function clearCooldownById(id) {
        for (const key of Object.keys(settings)) {
            if (matchingSkill(id, effectiveId(key))) state[key] = null;
        }
    }

    function tick() {
        const timestamp = now();
        for (const key of Object.keys(settings)) {
            const item = state[key];
            if (!item) continue;
            if (item.poppedDueAt) trySendPopped(key, item);
            if (item.announced || !item.armed) continue;
            const remaining = item.endAt - timestamp;
            if (remaining > TEN_SECONDS_MS) continue;
            if (remaining <= SEND_WINDOW_MS) {
                item.announced = true;
                if (reasonNotReady()) lastBlocked = key + ': 10s notice missed; ' + reasonNotReady();
                continue;
            }
            if (reasonNotReady()) {
                lastBlocked = key + ': 10s notice awaiting ' + reasonNotReady();
                continue;
            }
            item.announced = true;
            sendPartyMessage(key, settings[key].message);
        }
    }

    function clear() {
        state.bloodlust = null;
        state.enrage = null;
    }

    function status() {
        const parts = ['Party calls: ' + (enabled ? 'ON' : 'OFF'),
            'tank-only, in-combat, popped + 10s before cooldown ends'];
        for (const key of Object.keys(settings)) {
            const id = effectiveId(key);
            const item = state[key];
            const remaining = item ? Math.max(0, (item.endAt - now()) / 1000).toFixed(1) + 's' : 'not tracked';
            parts.push(settings[key].name + ': ID ' + (id || 'NOT SET') + ', ' + remaining);
        }
        parts.forEach(message);
        message('Eligibility: ' + (reasonNotReady() || 'READY') +
            ' | combat=' + !!mod.game.me.inCombat + ' | tank=' + tankStanceActive());
        message('Last matched: ' + lastMatched + ' | Last send: ' + lastSend +
            ' | Last blocked: ' + lastBlocked);
        if (lastCooldownPacket) message('Last cooldown packet: ' + lastCooldownPacket.id +
            ', ' + (lastCooldownPacket.milliseconds / 1000).toFixed(1) + 's' +
            (lastCooldownPacket.isStart ? ' (start)' : ' (decrease)'));
    }

    function command(...args) {
        const a = args.map(v => String(v).toLowerCase()).filter(Boolean);
        const action = a[0] || 'toggle';
        if (action === 'toggle' || action === 'on' || action === 'off') {
            enabled = action === 'toggle' ? !enabled : action === 'on';
            config.partyCalloutsEnabled = enabled;
            persist();
            message('Party cooldown announcements ' + (enabled ? 'ENABLED' : 'DISABLED') + '.');
        } else if (action === 'status') {
            status();
        } else if (settings[action] && isValidId(a[1])) {
            const key = action;
            config[settings[key].idKey] = Number(a[1]);
            state[key] = null;
            persist();
            message(settings[key].name + ' cooldown ID set to ' + a[1] + '.');
        } else if (settings[action] && a[1] === 'clear') {
            config[settings[action].idKey] = DEFAULT_PARTY_COOLDOWN_IDS[action];
            state[action] = null;
            persist();
            message(settings[action].name + ' cooldown ID reset to built-in ' + DEFAULT_PARTY_COOLDOWN_IDS[action] + '.');
        } else {
            message('Usage: /8 zerk party [on | off | status] | ' +
                'bloodlust <cooldown ID> | enrage <cooldown ID>');
        }
    }

    mod.hook('S_START_COOLTIME_SKILL', '*', event => updateCooldown(event, true));
    mod.hook('S_DECREASE_COOLTIME_SKILL', '*', event => updateCooldown(event, false));
    try {
        if (typeof mod.tryHook === 'function') mod.tryHook('S_CREST_MESSAGE', '*', event => {
            if (event && Number(event.type) === 6) clearCooldownById(normalizedId(event.skill));
        });
        else mod.hook('S_CREST_MESSAGE', '*', event => {
            if (event && Number(event.type) === 6) clearCooldownById(normalizedId(event.skill));
        });
    } catch (_) { /* Optional on some protocol versions. */ }
    for (const packet of ['S_LOAD_TOPO', 'S_LOGIN', 'S_RETURN_TO_LOBBY']) {
        mod.hook(packet, '*', clear);
    }
    const timer = mod.setInterval(tick, TICK_MS);
    return {
        command,
        destroy() { mod.clearInterval(timer); clear(); }
    };
};
