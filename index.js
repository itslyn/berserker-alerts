'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const createPartyCallouts = require('./party-callouts');

// Asura skill and abnormality IDs.
const INTIMIDATION_ID = 401400;
const PUNISHING_STRIKE_ID = 401500;
const HAMMERED_ID = 10153142;
const RAGING_FURY_SELF_ID = 91900403;
const FLURRY_TANK_ID = 400508;
const FLURRY_DPS_ID = 400502;
const BLOODLUST_CAST_ID = 60401323;
const BLOODLUST_ALTERNATE_CAST_ID = 61401324;
const REQUIRED_STACKS = 2;
const REPEAT_MS = 5000;
const COMBAT_START_GRACE_MS = 3000;
const FIRST_BOSS_GRACE_MS = 1500;
const BOSS_STALE_MS = 60000;
const BUFF_NOTICE_MS = 3000;
const BUFF_END_GRACE_MS = 400;
const DEFAULT_RAGING_DURATION_MS = 31900;
const CONFIG_FILE = path.join(__dirname, 'config.json');

module.exports = function PunishingStrikeAlert(mod) {
    mod.game.initialize('me.abnormalities');

    const defaults = {
        bloodlustSkillId: BLOODLUST_CAST_ID,
        bloodlustFallbackEnabled: true,
        bloodlustFlurrySeconds: 40,
        extraFlurryAbnormalityIds: []
    };
    let config = { ...defaults };
    try {
        config = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    } catch (e) {
        mod.log('[Berserker Alerts] config.json missing or invalid; using defaults.');
    }
    if (!Array.isArray(config.extraFlurryAbnormalityIds)) config.extraFlurryAbnormalityIds = [];
    const extraFlurryIds = new Set(config.extraFlurryAbnormalityIds.map(Number).filter(Number.isSafeInteger));
    let bloodlustSkillId = Number.isSafeInteger(Number(config.bloodlustSkillId)) && Number(config.bloodlustSkillId) > 0
        ? Number(config.bloodlustSkillId) : BLOODLUST_CAST_ID;
    let bloodlustFallbackEnabled = config.bloodlustFallbackEnabled !== false;
    let enabled = true;
    let buffsEnabled = true;
    let combatStartedAt = null;
    let stanceFromPackets = null;
    let stancePacketAt = 0;
    let stancePacketSource = 'none';
    let stancePacketConfirmedByState = false;
    const STANCE_PACKET_GRACE_MS = 1200;
    let bossId = null;
    let bossFirstSeenAt = 0;
    let bossLastSeenAt = 0;
    let lastWarningAt = 0;
    let lastPunishingNoticeBoss = null;
    let lastPunishingNoticeUntil = 0;
    const bossDebuffs = new Map();
    const bossOverrides = new Map();
    let raging = null;
    let ragingPendingDropAt = 0;
    let ragingMissing = false;
    let ragingLastMissingVoiceAt = 0;
    let ragingWarnedEndAt = 0;
    const flurrySources = new Map();
    let flurryWasActive = false;
    let flurryPendingDropAt = 0;
    let flurryMissing = false;
    let flurryLastMissingVoiceAt = 0;
    let flurryWarnedEndAt = 0;
    let lastFlurryAbnormalityId = null;
    let lastBloodlustCastAt = 0;
    let lastBloodlustCastSource = '';
    let lastBloodlustCastId = null;
    const voiceQueue = [];
    let speaking = false;
    let voiceFailed = false;
    let noticeFailed = false;

    const me = () => mod.game.me;
    const isBerserker = () => me().class === 'berserker';
    const isMyCharacter = id => { try { return !!me().is(id) || (id != null && me().gameId != null && String(id) === String(me().gameId)); } catch (_) { return false; } };
    const now = () => Date.now();
    const combatOk = () => isBerserker() && me().alive !== false && !!me().inCombat;
    const combatGraceElapsed = () => combatOk() && combatStartedAt !== null &&
        now() - combatStartedAt >= COMBAT_START_GRACE_MS;
    const canBuffAlert = () => enabled && buffsEnabled && combatGraceElapsed();
    function updateCombatState() {
        if (!combatOk()) {
            combatStartedAt = null;
            return;
        }
        if (combatStartedAt === null) {
            combatStartedAt = now();
            lastWarningAt = 0;
            ragingLastMissingVoiceAt = 0;
            flurryLastMissingVoiceAt = 0;
        }
    }

    function persist() {
        config.bloodlustSkillId = bloodlustSkillId;
        config.bloodlustFallbackEnabled = bloodlustFallbackEnabled;
        config.extraFlurryAbnormalityIds = [...extraFlurryIds];
        try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8'); }
        catch (e) { mod.command.message('Unable to save config.json: ' + e.message); }
    }
    function stanceFromGameState() {
        const active = me().abnormalities;
        if (!active || typeof active !== 'object') return null; // not initialized
        if (typeof active.has === 'function') {
            return active.has(INTIMIDATION_ID) || active.has(String(INTIMIDATION_ID));
        }
        return Object.prototype.hasOwnProperty.call(active, INTIMIDATION_ID);
    }

    // Resolve stance using observed Intimidation packets and Toolbox state.
    function tankStanceActive() {
        if (!isBerserker()) return false;
        const live = stanceFromGameState();
        if (stanceFromPackets === null) return live === true;
        if (live === null) return stanceFromPackets;
        if (live === stanceFromPackets) {
            stancePacketConfirmedByState = true;
            return live;
        }
        if (!stancePacketConfirmedByState || now() - stancePacketAt < STANCE_PACKET_GRACE_MS)
            return stanceFromPackets;
        return live;
    }

    function observeStancePacket(action, id, source) {
        if (Number(id) !== INTIMIDATION_ID) return;
        stanceFromPackets = action !== 'END';
        stancePacketAt = now();
        stancePacketSource = source;
        stancePacketConfirmedByState = stanceFromGameState() === stanceFromPackets;
    }

    function stanceStatus() {
        const live = stanceFromGameState();
        const age = stanceFromPackets === null ? 'none' :
            ((now() - stancePacketAt) / 1000).toFixed(1) + 's ago (' + stancePacketSource + ')';
        mod.command.message('Stance: ' + (tankStanceActive() ? 'TANK' : 'DPS') +
            ' | Intimidation 401400 in game-state: ' + (live === null ? 'unavailable' : live ? 'YES' : 'NO') +
            ' | last packet: ' + (stanceFromPackets === null ? 'none' : stanceFromPackets ? 'BEGIN/REFRESH' : 'END') +
            ' ' + age + ' | live confirmed: ' + (stancePacketConfirmedByState ? 'YES' : 'NO'));
    }

    function stance() {
        stanceStatus();
    }
    const partyCallouts = createPartyCallouts(mod, {
        config, persist, isBerserker,
        tankStanceActive,
        getBloodlustSkillId: () => bloodlustSkillId,
        onBloodlustCooldownStart: id => {
            if (!bloodlustFallbackEnabled) return;
            const timestamp = now();
            const seconds = Number(config.bloodlustFlurrySeconds);
            const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 40000;
            lastBloodlustCastAt = timestamp;
            lastBloodlustCastSource = 'S_START_COOLTIME_SKILL';
            lastBloodlustCastId = id;
            markFlurry('skill:Bloodlust', timestamp + ms);
        }
    });

    function clearBoss() {
        if (bossId !== null) bossOverrides.delete(bossId);
        bossId = null; bossFirstSeenAt = 0; bossLastSeenAt = 0; lastWarningAt = 0;
        lastPunishingNoticeBoss = null; lastPunishingNoticeUntil = 0;
    }
    function resetEncounter() { clearBoss(); bossDebuffs.clear(); bossOverrides.clear(); }
    function resetBuffs() {
        raging = null; ragingPendingDropAt = 0; ragingMissing = false;
        ragingLastMissingVoiceAt = 0; ragingWarnedEndAt = 0;
        flurrySources.clear(); flurryWasActive = false;
        flurryPendingDropAt = 0; flurryMissing = false;
        flurryLastMissingVoiceAt = 0; flurryWarnedEndAt = 0;
        lastFlurryAbnormalityId = null;
        lastBloodlustCastAt = 0;
        lastBloodlustCastSource = '';
        lastBloodlustCastId = null;
    }
    function getBossDebuff() {
        if (!bossId) return null;
        const debuff = bossDebuffs.get(bossId);
        if (!debuff) return null;
        if (debuff.until === Infinity || debuff.until > now()) return debuff;
        bossDebuffs.delete(bossId);
        return null;
    }
    // Hammered on the current boss takes priority over Punishing Strike.
    function bossHasHammered() {
        if (bossId === null) return false;
        const until = bossOverrides.get(bossId);
        if (until === undefined) return false;
        if (until === Infinity || until > now()) return true;
        bossOverrides.delete(bossId);
        return false;
    }
    function canPlayVoice(item) {
        if (item.requireCombat === 'tank') return enabled && combatGraceElapsed() && tankStanceActive() && !bossHasHammered();
        if (item.requireCombat === 'raging') return canBuffAlert() && tankStanceActive();
        if (item.requireCombat) return canBuffAlert();
        return true;
    }
    function speak(text, requireCombat = false) {
        if (voiceFailed || !canPlayVoice({ requireCombat })) return;
        if (voiceQueue.length >= 4 || voiceQueue.some(item => item.text === text)) return;
        voiceQueue.push({ text, requireCombat });
        playNextVoice();
    }
    function playNextVoice() {
        if (speaking || voiceFailed || voiceQueue.length === 0) return;
        if (process.platform !== 'win32') {
            voiceFailed = true;
            voiceQueue.length = 0;
            mod.log('Windows is required for TTS voice alerts.');
            return;
        }
        const item = voiceQueue.shift();
        if (!canPlayVoice(item)) return playNextVoice();
        if (item.requireCombat && item.text === 'Flurry of Blows' && validFlurryEnd()) return playNextVoice();
        if (item.requireCombat && item.text === 'Raging Fury' && (raging || (me().abnormalities && Object.prototype.hasOwnProperty.call(me().abnormalities, RAGING_FURY_SELF_ID)))) return playNextVoice();
        const text = item.text;
        const script = [
            'Add-Type -AssemblyName System.Speech',
            '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
            '$speaker.Volume = 80',
            '$speaker.Rate = 3',
            'try { $speaker.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female) } catch {}',
            `$speaker.Speak('${text.replace(/'/g, "''")}')`,
            '$speaker.Dispose()'
        ].join('; ');
        speaking = true;
        try {
            const child = spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script
            ], { stdio: 'ignore', windowsHide: true });
            child.once('error', error => {
                speaking = false;
                voiceFailed = true;
                voiceQueue.length = 0;
                mod.error('Windows speech failed: ' + error.message);
            });
            child.once('exit', code => {
                speaking = false;
                if (code !== 0) {
                    voiceFailed = true;
                    voiceQueue.length = 0;
                    mod.error('Windows speech failed. Restart Toolbox to retry.');
                } else playNextVoice();
            });
        } catch (error) {
            speaking = false;
            voiceFailed = true;
            voiceQueue.length = 0;
            mod.error('Windows speech failed: ' + error.message);
        }
    }
    function screenNotice(text, abnormalityId) {
        const iconId = Number(abnormalityId);
        const icon = Number.isSafeInteger(iconId) && iconId > 0
            ? `<img src='img://abonormality__${iconId}' width='26' height='26' vspace='-5' /> `
            : '';
        const message = `${icon}<font color="#FFE9A0">${text}</font>`;
        if (noticeFailed) return mod.command.message(message);
        try {
            const version = mod.majorPatchVersion >= 108 ? 4 : 3;
            const result = mod.toClient('S_CHAT', version, {
                channel: 21, name: '', message
            });
            if (result === false) throw new Error('Notice packet not accepted');
        } catch (e) {
            noticeFailed = true;
            mod.log('[Berserker Alerts] Local party notice unavailable: ' + e.message);
            mod.command.message(message);
        }
    }

    // Boss debuff expiry and stack reminders.
    function checkDebuff() {
        if (!enabled || !isBerserker() || !tankStanceActive()) return;
        if (!combatGraceElapsed() || !bossId) return;
        const time = now();
        if (time - bossFirstSeenAt < FIRST_BOSS_GRACE_MS) return;
        if (time - bossLastSeenAt > BOSS_STALE_MS) return;
        if (bossHasHammered()) return; // No Punishing Strike warnings of either kind.
        const debuff = getBossDebuff();
        if (debuff && Number.isFinite(debuff.until) &&
            debuff.until > time && debuff.until - time <= BUFF_NOTICE_MS &&
            (lastPunishingNoticeBoss !== bossId || lastPunishingNoticeUntil !== debuff.until)) {
            screenNotice('Punishing Strike: 3 seconds left', PUNISHING_STRIKE_ID);
            lastPunishingNoticeBoss = bossId;
            lastPunishingNoticeUntil = debuff.until;
        }
        if (debuff && (debuff.stacks === null || debuff.stacks >= REQUIRED_STACKS)) return;
        if (lastWarningAt && time - lastWarningAt < REPEAT_MS) return;
        lastWarningAt = time;
        speak(debuff && debuff.stacks === 1 ? 'Punishing Strike, one stack' : 'Punishing Strike', 'tank');
    }

    function getEndAt(event, fallbackMs) {
        const duration = Number(event.duration);
        if (Number.isFinite(duration) && duration > 0) {
            return duration > 2147483646 ? Infinity : now() + duration;
        }
        return now() + fallbackMs;
    }
    function getFlurryEndAt(event) {
        const duration = Number(event.duration);
        if (event.duration !== undefined && event.duration !== null &&
            Number.isFinite(duration) && duration > 0 && duration <= 2147483646) {
            return now() + duration;
        }
        return Infinity;
    }
    function flurryIconId() {
        for (const key of flurrySources.keys()) {
            if (key.startsWith('ab:')) return Number(key.slice(3));
        }
        return lastFlurryAbnormalityId || FLURRY_TANK_ID;
    }
    function isFlurryId(id) {
        if (id === FLURRY_TANK_ID || id === FLURRY_DPS_ID || extraFlurryIds.has(id)) return true;
        try {
            const data = mod.game.data && mod.game.data.abnormalities;
            const info = data && typeof data.get === 'function' && data.get(id);
            return !!info && /\bflurry of blows\b/i.test(String(info.name || ''));
        } catch (_) { return false; }
    }
    function cancelQueuedVoice(text) {
        for (let i = voiceQueue.length - 1; i >= 0; i--) {
            if (voiceQueue[i].requireCombat && voiceQueue[i].text === text) voiceQueue.splice(i, 1);
        }
    }

    function markFlurry(key, endAt) {
        flurrySources.set(key, endAt);
        flurryWasActive = true;
        flurryPendingDropAt = 0;
        flurryMissing = false;
        flurryLastMissingVoiceAt = 0;
        cancelQueuedVoice('Flurry of Blows');
    }
    function validFlurryEnd() {
        let latest = 0;
        for (const endAt of flurrySources.values()) {
            if (endAt > now()) latest = Math.max(latest, endAt);
        }
        return latest;
    }
    function trackOwnBuff(action, event) {
        if (!event || !isBerserker()) return;
        const id = Number(event.id);
        if (id === RAGING_FURY_SELF_ID) {
            if (action === 'END') {
                if (raging) { raging = null; ragingPendingDropAt = now() + BUFF_END_GRACE_MS; }
            } else {
                const endAt = getEndAt(event, DEFAULT_RAGING_DURATION_MS);
                raging = { endAt };
                ragingPendingDropAt = 0;
                ragingMissing = false;
                ragingLastMissingVoiceAt = 0;
                cancelQueuedVoice('Raging Fury');
            }
            return;
        }
        if (!isFlurryId(id)) return;
        const key = 'ab:' + id;
        if (action === 'END') {
            flurrySources.delete(key);
            if (flurryWasActive && validFlurryEnd() === 0) {
                flurryPendingDropAt = now() + BUFF_END_GRACE_MS;
            }
        } else {
            lastFlurryAbnormalityId = id;
            markFlurry(key, getFlurryEndAt(event));
        }
    }
    // Reconcile tracked Flurry packets with Toolbox active abnormalities.
    function syncFlurryFromGameState() {
        const active = me().abnormalities;
        if (!active || typeof active !== 'object') return;
        const seen = new Set();
        for (const [key, abnormality] of Object.entries(active)) {
            const id = Number(key);
            if (!Number.isSafeInteger(id)) continue;
            const name = abnormality && abnormality.data && String(abnormality.data.name || '');
            if (!isFlurryId(id) && !/\bflurry of blows\b/i.test(name)) continue;
            const remaining = Number(abnormality && abnormality.remaining);
            const until = Number(abnormality && abnormality.until);
            let endAt = 0;
            if (Number.isFinite(remaining) && remaining > 0) endAt = now() + remaining;
            else if (Number.isFinite(until) && until > now()) endAt = until;
            if (!endAt) continue;
            const stateKey = 'state:' + id;
            seen.add(stateKey);
            flurrySources.set(stateKey, endAt);
            flurryWasActive = true;
            lastFlurryAbnormalityId = id;
            flurryPendingDropAt = 0;
            flurryMissing = false;
            flurryLastMissingVoiceAt = 0;
            cancelQueuedVoice('Flurry of Blows');
        }
        for (const key of flurrySources.keys()) {
            if (key.startsWith('state:') && !seen.has(key)) flurrySources.delete(key);
        }
    }

    // Self buff alerts; tank only for Raging Fury, both stances for Flurry.
    function checkBuffs() {
        if (!isBerserker()) return;
        const time = now();
        syncFlurryFromGameState();
        if (raging && raging.endAt !== Infinity && raging.endAt <= time) {
            raging = null;
            ragingPendingDropAt = time + BUFF_END_GRACE_MS;
        }
        if (raging && raging.endAt !== Infinity && canBuffAlert() && tankStanceActive() &&
            raging.endAt - time <= BUFF_NOTICE_MS && raging.endAt > time &&
            ragingWarnedEndAt !== raging.endAt) {
            screenNotice('Raging Fury: 3 seconds left', RAGING_FURY_SELF_ID);
            ragingWarnedEndAt = raging.endAt;
        }
        if (!raging && ragingPendingDropAt && time >= ragingPendingDropAt) {
            ragingPendingDropAt = 0;
            ragingMissing = true;
        }
        const ownAbnormalities = me().abnormalities;
        const ragingInGameState = !!ownAbnormalities && (
            (typeof ownAbnormalities.has === 'function' &&
                (ownAbnormalities.has(RAGING_FURY_SELF_ID) || ownAbnormalities.has(String(RAGING_FURY_SELF_ID)))) ||
            Object.prototype.hasOwnProperty.call(ownAbnormalities, RAGING_FURY_SELF_ID)
        );
        if (!raging && !ragingInGameState && !ragingPendingDropAt &&
            canBuffAlert() && tankStanceActive() &&
            (!ragingLastMissingVoiceAt || time - ragingLastMissingVoiceAt >= REPEAT_MS)) {
            ragingLastMissingVoiceAt = time;
            speak('Raging Fury', 'raging');
        }
        for (const [key, endAt] of flurrySources) {
            if (endAt !== Infinity && endAt <= time) flurrySources.delete(key);
        }
        const latestEnd = validFlurryEnd();
        if (latestEnd) {
            flurryPendingDropAt = 0;
            flurryMissing = false;
            if (latestEnd !== Infinity && canBuffAlert() &&
                latestEnd - time <= BUFF_NOTICE_MS && latestEnd > time &&
                flurryWarnedEndAt !== latestEnd) {
                screenNotice('Flurry of Blows: 3 seconds left', flurryIconId());
                flurryWarnedEndAt = latestEnd;
            }
        } else if (flurryWasActive && !flurryPendingDropAt && !flurryMissing) {
            flurryPendingDropAt = time + BUFF_END_GRACE_MS;
        }
        if (!latestEnd && flurryPendingDropAt && time >= flurryPendingDropAt) {
            flurryPendingDropAt = 0;
            flurryMissing = true;
        }
        if (!latestEnd && !flurryPendingDropAt && canBuffAlert() &&
            (!flurryLastMissingVoiceAt || time - flurryLastMissingVoiceAt >= REPEAT_MS)) {
            flurryMissing = true;
            flurryLastMissingVoiceAt = time;
            speak('Flurry of Blows', true);
        }
    }

    function updateAbnormality(event) {
        if (!event || !isBerserker()) return;
        const id = Number(event.id);
        if (isMyCharacter(event.target)) {
            observeStancePacket('BEGIN/REFRESH', id, 'S_ABNORMALITY_BEGIN/REFRESH');
            trackOwnBuff('BEGIN', event);
        }
        if (id === HAMMERED_ID) {
            const duration = Number(event.duration);
            const until = Number.isFinite(duration) && duration > 0 && duration <= 2147483646
                ? now() + duration : Infinity;
            const target = String(event.target);
            bossOverrides.set(target, until);
            if (target === bossId) {
                for (let i = voiceQueue.length - 1; i >= 0; i--) {
                    if (voiceQueue[i].requireCombat === 'tank') voiceQueue.splice(i, 1);
                }
            }
            return;
        }
        if (id !== PUNISHING_STRIKE_ID) return;
        const duration = Number(event.duration);
        const until = Number.isFinite(duration) && duration > 0 ? now() + duration : Infinity;
        const target = String(event.target);
        const previous = bossDebuffs.get(target);
        const count = event.stacks === undefined || event.stacks === null ? NaN : Number(event.stacks);
        const stacks = Number.isInteger(count) && count >= 0 ? count : (previous ? previous.stacks : null);
        bossDebuffs.set(target, { until, stacks });
        if (target === bossId && stacks >= REQUIRED_STACKS) lastWarningAt = 0;
    }
    function endAbnormality(event) {
        if (!event) return;
        const id = Number(event.id);
        if (isMyCharacter(event.target)) {
            observeStancePacket('END', id, 'S_ABNORMALITY_END');
            trackOwnBuff('END', event);
        }
        if (id === HAMMERED_ID) {
            const target = String(event.target);
            bossOverrides.delete(target);
            if (target === bossId) lastWarningAt = 0;
            return;
        }
        if (id === PUNISHING_STRIKE_ID) {
            const target = String(event.target);
            bossDebuffs.delete(target);
            if (target === bossId) {
                lastPunishingNoticeBoss = null;
                lastPunishingNoticeUntil = 0;
            }
        }
    }
    // Bloodlust fallback when no separate Flurry abnormality is exposed.
    function castSkill(event, source = 'client') {
        if (!isBerserker() || !event) return;
        const skill = event.skill;
        const id = Number(skill && typeof skill === 'object' ? skill.id : skill);
        if (!Number.isSafeInteger(id) || id <= 0) return;
        const timestamp = now();
        if (!bloodlustFallbackEnabled ||
            (id !== bloodlustSkillId && id !== BLOODLUST_CAST_ID && id !== BLOODLUST_ALTERNATE_CAST_ID)) return;
        const duplicate = lastBloodlustCastAt && timestamp - lastBloodlustCastAt < 1200;
        lastBloodlustCastAt = timestamp;
        lastBloodlustCastId = id;
        lastBloodlustCastSource = source;
        if (!duplicate) {
            const seconds = Number(config.bloodlustFlurrySeconds);
            const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 40000;
            markFlurry('skill:Bloodlust', timestamp + ms);
        }
    }
    function optionalHook(name, fn) {
        try {
            if (typeof mod.tryHook === 'function') mod.tryHook(name, '*', fn);
            else mod.hook(name, '*', fn);
        } catch (e) { mod.log('[Berserker Alerts] Could not hook ' + name + ': ' + e.message); }
    }
    mod.hook('S_ABNORMALITY_BEGIN', '*', updateAbnormality);
    mod.hook('S_ABNORMALITY_REFRESH', '*', updateAbnormality);
    mod.hook('S_ABNORMALITY_END', '*', endAbnormality);
    optionalHook('S_PARTY_MEMBER_ABNORMAL_ADD', event => {
        if (event && String(event.serverId) === String(me().serverId) &&
            String(event.playerId) === String(me().playerId)) {
            observeStancePacket('BEGIN', event.id, 'S_PARTY_MEMBER_ABNORMAL_ADD');
            trackOwnBuff('BEGIN', event);
        }
    });
    optionalHook('S_PARTY_MEMBER_ABNORMAL_REFRESH', event => {
        if (event && String(event.serverId) === String(me().serverId) &&
            String(event.playerId) === String(me().playerId)) {
            observeStancePacket('REFRESH', event.id, 'S_PARTY_MEMBER_ABNORMAL_REFRESH');
            trackOwnBuff('REFRESH', event);
        }
    });
    optionalHook('S_PARTY_MEMBER_ABNORMAL_DEL', event => {
        if (event && String(event.serverId) === String(me().serverId) &&
            String(event.playerId) === String(me().playerId)) {
            observeStancePacket('END', event.id, 'S_PARTY_MEMBER_ABNORMAL_DEL');
            trackOwnBuff('END', event);
        }
    });
    for (const name of [
        'C_START_SKILL', 'C_START_COMBO_INSTANT_SKILL', 'C_START_INSTANCE_SKILL',
        'C_START_INSTANCE_SKILL_EX', 'C_START_TARGETED_SKILL'
    ]) optionalHook(name, event => castSkill(event, name));
    optionalHook('S_ACTION_STAGE', event => {
        if (event && isMyCharacter(event.gameId) && Number(event.stage) === 0) {
            castSkill(event, 'S_ACTION_STAGE');
        }
    });

    mod.hook('S_BOSS_GAGE_INFO', '*', event => {
        if (!isBerserker()) return;
        const id = String(event.id);
        if (Number(event.curHp) <= 0) { if (id === bossId) clearBoss(); return; }
        const time = now();
        if (bossId !== id) {
            bossId = id; bossFirstSeenAt = time; lastWarningAt = 0;
            lastPunishingNoticeBoss = null; lastPunishingNoticeUntil = 0;
        }
        bossLastSeenAt = time;
    });
    mod.hook('S_CREATURE_LIFE', '*', event => {
        if (event.alive === false && String(event.gameId) === bossId) clearBoss();
    });
    mod.hook('S_DESPAWN_NPC', '*', event => {
        bossDebuffs.delete(String(event.gameId));
        bossOverrides.delete(String(event.gameId));
        if (String(event.gameId) === bossId) clearBoss();
    });
    for (const name of ['S_LOAD_TOPO', 'S_LOGIN', 'S_RETURN_TO_LOBBY']) {
        mod.hook(name, '*', () => { resetEncounter(); resetBuffs(); stanceFromPackets = null; stancePacketAt = 0; stancePacketSource = 'none'; stancePacketConfirmedByState = false; combatStartedAt = null; });
    }
    const interval = mod.setInterval(() => {
        updateCombatState();
        for (let i = voiceQueue.length - 1; i >= 0; i--) {
            if (!canPlayVoice(voiceQueue[i])) voiceQueue.splice(i, 1);
        }
        checkDebuff();
        checkBuffs();
    }, 250);

    function status() {
        const current = getBossDebuff();
        const debuff = !bossId ? 'no tracked boss' : !current ? 'missing (0 stacks)' :
            current.stacks === null ? 'present (unknown stacks)' :
                `${current.stacks} stack(s)${current.stacks >= REQUIRED_STACKS ? ' (OK)' : ' (needs 2)'}`;
        mod.command.message(`Alerts: ${enabled ? 'ON' : 'OFF'} | Class: ${me().class || 'unknown'} | Intimidation: ${tankStanceActive() ? 'ON (tank)' : 'OFF (DPS)'} | In combat: ${!!me().inCombat} | Grace: ${combatOk() ? (combatGraceElapsed() ? 'complete' : Math.max(0, (COMBAT_START_GRACE_MS - (combatStartedAt === null ? 0 : now() - combatStartedAt)) / 1000).toFixed(1) + 's remaining') : 'out of combat'} | Punishing Strike: ${bossHasHammered() ? 'SUPPRESSED (Hammered 10153142)' : debuff}`);
        buffStatus();
        stanceStatus();
    }
    function remainingText(expiration) {
        if (!expiration) return 'not tracked';
        if (expiration === Infinity) return 'active (waiting for END packet)';
        return Math.max(0, (expiration - now()) / 1000).toFixed(1) + 's';
    }
    function buffStatus() {
        syncFlurryFromGameState();
        mod.command.message(`Buffs: ${enabled && buffsEnabled ? 'ON' : 'OFF'} | Combat-only: YES | In combat: ${!!me().inCombat} | Raging Fury: ${remainingText(raging && raging.endAt)} | Flurry: ${remainingText(validFlurryEnd())} [last abnormality: ${lastFlurryAbnormalityId || 'none'}]`);
        const tracked = [...flurrySources.entries()].map(([key, endAt]) => key + '=' + remainingText(endAt)).join(', ') || 'none';
        mod.command.message(`Flurry sources: ${tracked} | Bloodlust cast ID: ${bloodlustSkillId} (built-in ${BLOODLUST_CAST_ID}, alt ${BLOODLUST_ALTERNATE_CAST_ID}) | fallback ${bloodlustFallbackEnabled ? 'ON' : 'OFF'}`);
        mod.command.message('Last Bloodlust detection: ' + (lastBloodlustCastAt ?
            lastBloodlustCastSource + ' (' + ((now() - lastBloodlustCastAt) / 1000).toFixed(1) + 's ago, ID ' + lastBloodlustCastId + ')' :
            'none since loading this zone'));

    }
    function setAlerts(next) {
        enabled = next;
        if (!enabled) voiceQueue.length = 0;
        mod.command.message('Berserker buff/debuff alerts ' + (enabled ? 'ON' : 'OFF') + '.');
    }
    function alerts(action) {
        const choice = String(action || 'toggle').toLowerCase();
        if (choice === 'toggle') setAlerts(!enabled);
        else if (choice === 'on') setAlerts(true);
        else if (choice === 'off') setAlerts(false);
        else if (choice === 'status') mod.command.message('Berserker buff/debuff alerts ' + (enabled ? 'ON' : 'OFF') + '.');
        else mod.command.message('Usage: /8 zerk alerts [on | off | status]');
    }

    mod.command.add('zerk', {
        alerts,
        on() { setAlerts(true); },
        off() { setAlerts(false); },
        buffs: buffStatus,
        stance,
        buffson() { buffsEnabled = true; mod.command.message('Raging Fury and Flurry alerts ON.'); },
        buffsoff() { buffsEnabled = false; mod.command.message('Raging Fury and Flurry alerts OFF; Punishing Strike unchanged.'); },
        party: (...args) => partyCallouts.command(...args),
        status,
        $default() { mod.command.message('/8 zerk alerts [on/off] | party [on/off] | status | stance | buffs'); }
    });
    this.destructor = () => {
        mod.clearInterval(interval);
        partyCallouts.destroy();
        mod.command.remove('zerk');
        voiceQueue.length = 0;
    };
};
