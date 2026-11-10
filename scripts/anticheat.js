const S = require("hgsettings"); // числовые настройки берутся из меню: Настройки -> HostGuard


// Первые RETURN_FIRST нарушений игрока просто возвращают его в последнюю безопасную точку
// без наказания. Начиная со следующего - обычное наказание (заморозка/derelict, в PvP - предупреждения и бан).
// 0 - сразу наказывать, как раньше.

// После возврата клиент ещё какое-то время может слать старую (читерскую) позицию.
// Пока игрок не "встал" на место (в пределах RETURN_TOLERANCE), проверки не идут и нарушением это не считается.


function serverActive() {
    try { return !!Vars.net.server(); } catch (e) { return false; }
}
function active() {
    return S.get("anticheat_on") && serverActive();
}

// Вид наказания меняется командой /punish и хранится в настройках игры:
//   freeze   - заморозка, команда не меняется
//   derelict - перенос в derelict (по умолчанию)
const MODE_KEY = "anticheat-mode";

// Действия, запрещённые наказанному игроку
const FROZEN_ACTIONS = ["placeBlock", "breakBlock", "configure", "rotate", "withdrawItem",
    "depositItem", "control", "buildSelect", "command", "commandUnits", "commandBuilding",
    "removePlanned", "pickupBlock", "dropPayload"];

const last = {};
const safe = {};       // p.id -> { unit, x, y } последняя безопасная позиция
const pending = {};    // p.id -> { unit, x, y, left } игрока вернули, ждём пока клиент примет позицию
const returns = {};    // uuid -> сколько раз игрока уже возвращали в исходную точку
const strikes = {};
const pvpStrikes = {};
const jail = {};
const homeTeam = {};
const shown = {};

let tick = 0;
let lastCheck = Time.millis();
let accDelta = 0;      // сколько игровых тиков прошло с прошлой проверки (с учётом лагов)
let maxFrameDelta = 0; // самый длинный кадр с прошлой проверки
let wasPaused = false;
function fmt(totalSec) {
    totalSec = Math.max(0, Math.ceil(totalSec));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
}

function punishMode() {
    return Core.settings.getString(MODE_KEY, "derelict") == "freeze" ? "freeze" : "derelict";
}

function setPunishMode(v) {
    Core.settings.put(MODE_KEY, v == "freeze" ? "freeze" : "derelict");
}

function gamePaused() {
    return Vars.state.is(Packages.mindustry.core.GameState.State.paused) || Vars.state.isPaused();
}

function showJailTime(p, ms) {
    const sec = Math.ceil(ms / 1000);
    if (shown[p.uuid()] === sec) return;
    shown[p.uuid()] = sec;
    Call.setHudText(p.con, "[scarlet]Наказание: осталось [white]" + fmt(sec));
}

function dropUnit(p) {
    if (p.dead()) return;
    const u = p.unit();
    p.clearUnit();
    u.remove();
}

function derelictJail(p) {
    if (p.team() == Team.derelict) {
        dropUnit(p);
        return;
    }

    const home = homeTeam[p.uuid()] || p.team();
    const c = home.core();
    if (c != null) c.requestSpawn(p);

    p.team(Team.derelict);
    dropUnit(p);

    Time.run(5, () => {
        try {
            if (!p.isAdded() || p.team() != Team.derelict) return;
            dropUnit(p);
        } catch (err) {
            Log.err("[anticheat] ошибка удаления юнита: " + err);
        }
    });
}

function freezeJail(p) {
    const uuid = p.uuid();

    if (p.team() == Team.derelict) {
        let home = homeTeam[uuid];
        if (home == null || home == Team.derelict) home = Vars.state.rules.defaultTeam;
        p.team(home);
    }

    if (p.dead()) return;
    const u = p.unit();
    if (u == null) return;

    const left = jail[uuid] != null ? jail[uuid] : 0;
    const ticks = Math.max(60, Math.ceil(left / 1000 * 60));
    try {
        u.apply(StatusEffects.unmoving, ticks);
        u.apply(StatusEffects.disarmed, ticks);
    } catch (err) {
        Log.err("[anticheat] не удалось применить заморозку: " + err);
    }
}

function clearFreeze(p) {
    if (p.dead()) return;
    const u = p.unit();
    if (u == null) return;
    try {
        u.unapply(StatusEffects.unmoving);
        u.unapply(StatusEffects.disarmed);
    } catch (err) {}
}

function applyJail(p) {
    if (punishMode() == "freeze") freezeJail(p);
    else derelictJail(p);
}

function release(p) {
    const uuid = p.uuid();
    let home = homeTeam[uuid];
    if (home == null || home == Team.derelict) home = Vars.state.rules.defaultTeam;

    delete jail[uuid];
    delete homeTeam[uuid];
    delete shown[uuid];
    Call.hideHudText(p.con);

    if (p.team() != home) p.team(home);
    clearFreeze(p);
    Call.sendMessage("[scarlet][anticheat][white] " + p.name + "[white] наказание снято");
}

function describe(moved, allowed, info) {
    return info != null ? info : "рывок на " + Math.round(moved) + " (допустимо " + Math.round(allowed) + ")";
}

function pvpViolation(p, moved, allowed, info) {
    const uuid = p.uuid();
    const n = (pvpStrikes[uuid] || 0) + 1;
    pvpStrikes[uuid] = n;

    delete last[p.id];

    if (n >= S.get("pvp_ban_at")) {
        Call.sendMessage("[scarlet][anticheat][white] " + p.name + "[white] " + describe(moved, allowed, info) + ". Нарушение №" + n + ", бан");
        Log.info("[anticheat] " + p.name + " (" + uuid + ") нарушение " + n + ", бан");
        Vars.netServer.admins.banPlayerID(uuid);
        p.kick("Бан за читы (телепорт/ускорение)");
    } else {
        p.sendMessage("[scarlet][anticheat][white] " + describe(moved, allowed, info) + ". Предупреждение " + n + "/" + S.get("pvp_ban_at"));
    }
}

function moveBack(p, u) {
    const s = safe[p.id];
    if (s == null || s.unit != u) return false;

    try {
        u.set(s.x, s.y);
        u.vel.setZero();
        Call.setPosition(p.con, s.x, s.y);
    } catch (err) {
        Log.err("[anticheat] не удалось вернуть игрока: " + err);
    }

    delete last[p.id];
    pending[p.id] = { unit: u, x: s.x, y: s.y, left: S.get("return_settle") };
    return true;
}

function holdPending(p, u) {
    const pend = pending[p.id];
    if (pend == null) return false;

    if (u == null || pend.unit != u) {
        delete pending[p.id];
        return false;
    }

    pend.left--;
    const off = Mathf.dst(u.x, u.y, pend.x, pend.y);
    if (off > S.get("return_tolerance") && pend.left > 0) {
        try {
            u.set(pend.x, pend.y);
            u.vel.setZero();
            Call.setPosition(p.con, pend.x, pend.y);
        } catch (err) {}
    } else {
        delete pending[p.id];
        delete last[p.id];
    }
    return true;
}

function tryReturn(p, u, desc) {
    if (S.get("return_first") <= 0) return false;

    const s = safe[p.id];
    if (s == null || s.unit != u) return false;

    const uuid = p.uuid();
    const n = (returns[uuid] || 0) + 1;
    if (n > S.get("return_first")) return false;
    returns[uuid] = n;

    moveBack(p, u);

    p.sendMessage("[scarlet][anticheat][white] " + desc + ". Возврат в исходную точку " + n + "/" + S.get("return_first"));
    return true;
}

function punish(p, moved, allowed, info) {
    delete returns[p.uuid()];

    if (Vars.state.rules.pvp) {
        if (!S.get("pvp_punish")) {
            // наказания в PvP отключены: нарушителя уже вернули на место, страйки и бан не выдаём
            S.debug("PvP: наказание отключено, " + p.plainName() + " рывок " + Math.round(moved) + " / допустимо " + Math.round(allowed));
            delete last[p.id];
            p.sendMessage("[scarlet][anticheat][white] Рывок отменён, тебя вернули на место.");
            return;
        }
        pvpViolation(p, moved, allowed, info);
        return;
    }

    const uuid = p.uuid();
    const n = (strikes[uuid] || 0) + 1;
    strikes[uuid] = n;

    const what = punishMode() == "freeze" ? "заморозка" : "derelict";
    const secs = n * S.get("base_seconds");
    jail[uuid] = secs * 1000;
    homeTeam[uuid] = p.team();

    Call.sendMessage("[scarlet][anticheat][white] " + p.name + "[white] " + describe(moved, allowed, info) + ". Нарушение №" + n + ", " + what + " на " + fmt(secs));

    delete last[p.id];
    applyJail(p);
}

// Каждый игрок (кроме хоста) получает номер при первом входе. Номер и ник сохраняются
// навсегда: после выхода и перезапуска игры у игрока остаётся тот же номер.
const idByUuid = {};  // uuid -> номер
const uuidById = {};  // номер -> uuid
const nameById = {};  // номер -> последний ник
let nextId = 1;

// Номера и ники сохраняются в настройках игры и переживают перезапуск
const IDS_KEY = "anticheat-ids";

function saveIds() {
    Core.settings.put(IDS_KEY, JSON.stringify({ next: nextId, ids: idByUuid, names: nameById }));
}

function loadIds() {
    try {
        const s = String(Core.settings.getString(IDS_KEY, ""));
        if (s.length == 0) return;
        const d = JSON.parse(s);
        nextId = d.next || 1;
        for (let u in d.ids) {
            idByUuid[u] = d.ids[u];
            uuidById[d.ids[u]] = u;
        }
        for (let k in d.names) nameById[k] = d.names[k];
    } catch (err) {
        Log.err("[anticheat] ошибка загрузки номеров игроков: " + err);
    }
}

function clearIds() {
    for (let k in idByUuid) delete idByUuid[k];
    for (let k in uuidById) delete uuidById[k];
    for (let k in nameById) delete nameById[k];
    nextId = 1;
    try { Core.settings.remove(IDS_KEY); } catch (err) {}
}

clearIds();

function idOf(p) {
    const uuid = p.uuid();
    let changed = false;

    if (idByUuid[uuid] == null) {
        const id = nextId++;
        idByUuid[uuid] = id;
        uuidById[id] = uuid;
        changed = true;
    }

    const id = idByUuid[uuid];
    const name = p.plainName();
    if (nameById[id] != name) {
        nameById[id] = name;
        changed = true;
    }

    if (changed) saveIds();
    return id;
}

function getPlayers() {
    const list = [];
    Groups.player.each(p => {
        if (p.isLocal()) return;
        const uuid = p.uuid();
        list.push({
            id: idOf(p),
            player: p,
            strikes: strikes[uuid] || 0,
            pvp: pvpStrikes[uuid] || 0,
            jail: jail[uuid]
        });
    });
    list.sort((x, y) => x.id - y.id);
    return list;
}

function findOnline(uuid) {
    let found = null;
    Groups.player.each(p => { if (p.uuid() == uuid) found = p; });
    return found;
}

function findByNumber(arg) {
    const id = parseInt(arg);
    const uuid = uuidById[id];
    if (uuid == null) return null;

    const online = findOnline(uuid);
    return { id: id, uuid: uuid, name: online != null ? online.plainName() : nameById[id], player: online };
}

function findPlayerByNameOrNumber(arg) {
    if (!arg) return null;
    const s = String(arg);

    if (/^\d+$/.test(s)) {
        const uuid = uuidById[parseInt(s)];
        return uuid != null ? findOnline(uuid) : null;
    }

    const name = s.toLowerCase();
    let found = null;
    Groups.player.each(p => {
        const clean = p.name.replace(/\[[^\]]*\]/g, "").toLowerCase();
        if (clean.includes(name) || p.name.toLowerCase().includes(name)) {
            found = p;
        }
    });
    return found;
}

function isAdmin(p) {
    return p.admin || p.isLocal();
}

// Реакция на переключение античита в меню настроек (проверяется каждый тик)
let prevOn = true;
function syncEnabled() {
    const on = S.get("anticheat_on");
    if (on === prevOn) return;
    prevOn = on;
    Log.info("[anticheat] " + (on ? "включён" : "выключен") + " (меню настроек)");
    if (!on) {
        Groups.player.each(p => {
            if (jail[p.uuid()] != null) release(p);
        });
        for (let key in last) delete last[key];
    } else {
        lastCheck = Time.millis();
    }
}

Events.run(Trigger.update, () => {
    syncEnabled();
    tick++;

    if (gamePaused()) {
        wasPaused = true;
        lastCheck = Time.millis();
        accDelta = 0;
        maxFrameDelta = 0;
        return;
    }

    accDelta += Time.delta;
    if (Time.delta > maxFrameDelta) maxFrameDelta = Time.delta;

    if (tick % S.get("check_ticks") != 0) return;

    const now = Time.millis();
    const dt = Math.min(now - lastCheck, 2000);
    lastCheck = now;

    const elapsed = Math.max(accDelta, dt / 1000 * 60, S.get("check_ticks"));
    const lagged = wasPaused || maxFrameDelta > S.get("lag_frame_delta") || dt > S.get("check_ticks") / 60 * 1000 + S.get("lag_real_ms");
    accDelta = 0;
    maxFrameDelta = 0;

    if (!active()) return;

    if (lagged) {
        S.debug("лаг: проверка пропущена (пауза=" + wasPaused + ", maxFrameDelta=" + maxFrameDelta.toFixed(1) + ", dt=" + dt + " мс)");
        wasPaused = false;
        for (let key in last) delete last[key];
    }

    Groups.player.each(p => {
        if (p.isLocal()) return;

        const uuid = p.uuid();

        if (jail[uuid] != null) {
            jail[uuid] -= dt;

            if (jail[uuid] <= 0) {
                release(p);
                delete pending[p.id];
            } else {
                showJailTime(p, jail[uuid]);
                applyJail(p);
                if (pending[p.id] != null) holdPending(p, p.dead() ? null : p.unit());
            }
            return;
        }

        if (p.team() == Team.derelict) return;

        if (p.dead() || p.unit() == null) {
            delete last[p.id];
            delete pending[p.id];
            return;
        }

        const u = p.unit();
        const r = last[p.id];

        if (holdPending(p, u)) return;

        if (u.type.naval && !u.type.flying) {
            const tile = u.tileOn();
            if (tile != null) {
                const floor = tile.floor();
                if (!floor.isLiquid) {
                    if (S.get("log_only")) {
                        Log.info("[anticheat] " + p.name + " корабль на суше (" + floor.name + ")");
                        Call.sendMessage("[scarlet][anticheat][white] " + p.name + "[white] корабль на суше");
                    } else {
                        if (!tryReturn(p, u, "корабль на суше")) {
                            moveBack(p, u);
                            punish(p, 999, 0, "корабль на суше");
                        }
                    }
                    delete last[p.id];
                    return;
                }
            }
        }

        if (r == null || r.unit != u || r.type != u.type) {
            last[p.id] = { unit: u, type: u.type, x: u.x, y: u.y, grace: S.get("grace_checks") };
            safe[p.id] = { unit: u, x: u.x, y: u.y };
            return;
        }

        if (r.grace > 0) {
            r.grace--;
            r.x = u.x;
            r.y = u.y;
            safe[p.id] = { unit: u, x: u.x, y: u.y };
            return;
        }

        const moved = Mathf.dst(u.x, u.y, r.x, r.y);
        const allowed = Math.max(u.speed() * elapsed * S.get("lag_mult"), S.get("min_allowed"));
        const velMult = S.get("vel_mult");
        const maxVel = u.speed() * velMult;
        const curVel = u.vel.len();
        // множитель 0.0 отключает проверку скорости (иначе допустимая скорость была бы нулевой)
        const fast = velMult > 0 && curVel > maxVel;

        if (moved > allowed || fast) {
            // ускорение (скорость выше допустимой) отличаем от рывка/телепорта (слишком большое смещение)
            const speedHack = fast;
            const kind = speedHack ? "ускорение" : "рывок";
            const info = speedHack
                ? "ускорение: скорость " + curVel.toFixed(1) + " (допустимо " + maxVel.toFixed(1) + ")"
                : "рывок на " + Math.round(moved) + " (допустимо " + Math.round(allowed) + ")";
            S.debug(p.plainName() + ": " + kind + ", смещение " + Math.round(moved) + " (допустимо " + Math.round(allowed) + "), vel " + curVel.toFixed(2) + " (макс " + maxVel.toFixed(2) + "), тиков " + Math.round(elapsed));
            if (S.get("log_only")) {
                Log.info("[anticheat] " + p.name + " " + info);
                Call.sendMessage("[scarlet][anticheat][white] " + p.name + "[white] " + info);
                r.x = u.x;
                r.y = u.y;
                return;
            }
            const jump = speedHack ? curVel : moved;
            const lim = speedHack ? maxVel : allowed;
            if (!tryReturn(p, u, info)) {
                moveBack(p, u);
                punish(p, jump, lim, info);
            }
        } else {
            r.x = u.x;
            r.y = u.y;
            safe[p.id] = { unit: u, x: u.x, y: u.y };
        }
    });
});

Events.on(PlayerJoin, e => {
    if (!serverActive()) return;
    if (!e.player.isLocal()) idOf(e.player);
    const uuid = e.player.uuid();
    if (active() && jail[uuid] != null) {
        delete shown[uuid];
        applyJail(e.player);
        e.player.sendMessage("[scarlet][anticheat][white] Ты ещё под наказанием, осталось " + fmt(jail[uuid] / 1000));
    }
});

Events.on(PlayerLeave, e => {
    delete last[e.player.id];
    delete safe[e.player.id];
    delete pending[e.player.id];
    delete shown[e.player.uuid()];
});

function clearAllData() {
    for (let key in last) delete last[key];
    for (let key in safe) delete safe[key];
    for (let key in pending) delete pending[key];
    for (let key in returns) delete returns[key];
    for (let key in strikes) delete strikes[key];
    for (let key in pvpStrikes) delete pvpStrikes[key];
    for (let key in jail) delete jail[key];
    for (let key in homeTeam) delete homeTeam[key];
    for (let key in shown) delete shown[key];

    tick = 0;
    lastCheck = Time.millis();

}

Events.on(ServerLoadEvent, () => {
    clearAllData();
    clearIds();
});

if (typeof ResetEvent !== "undefined") {
    Events.on(ResetEvent, () => {
        clearIds();
    });
}

const lastBlockMsg = {};
let filterInstalled = false;

function installActionFilter() {
    if (filterInstalled || !Vars.netServer) return;
    filterInstalled = true;

    Vars.netServer.admins.addActionFilter(action => {
        const p = action.player;
        if (p == null || !active()) return true;

        const uuid = p.uuid();
        if (jail[uuid] == null) return true;
        if (FROZEN_ACTIONS.indexOf(String(action.type)) < 0) return true;

        const now = Time.millis();
        if (lastBlockMsg[uuid] == null || now - lastBlockMsg[uuid] > 2000) {
            lastBlockMsg[uuid] = now;
            p.sendMessage("[scarlet]Пока ты под наказанием, это действие запрещено.");
        }
        return false;
    });
}

if (typeof UnitChangeEvent !== "undefined") {
    Events.on(UnitChangeEvent, e => {
        const p = e.player;
        if (p == null || !active() || punishMode() != "freeze") return;
        if (jail[p.uuid()] == null) return;
        Time.run(1, () => {
            if (jail[p.uuid()] != null) freezeJail(p);
        });
    });
}

installActionFilter();
Events.on(ServerLoadEvent, installActionFilter);
Events.on(ClientLoadEvent, installActionFilter);

module.exports = {
    strikes: strikes,
    pvpStrikes: pvpStrikes,
    jail: jail,
    fmt: fmt,
    idOf: idOf,
    getPlayers: getPlayers,
    findByNumber: findByNumber,
    findPlayerByNameOrNumber: findPlayerByNameOrNumber,
    release: release,
    isAdmin: isAdmin,
    isPaused: gamePaused,
    isEnabled: active,
    isServer: serverActive,
    getPunishMode: punishMode,
    setPunishMode: setPunishMode
};
