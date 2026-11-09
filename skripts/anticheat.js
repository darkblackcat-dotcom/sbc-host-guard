// anticheat.js — полный рабочий скрипт

const CHECK_TICKS = 12;
const MIN_ALLOWED = 48;
const LAG_MULT = 2.5;
const VEL_MULT = 2;
const GRACE_CHECKS = 1;
const BASE_SECONDS = 60;
const PVP_BAN_AT = 3;
const LAG_FRAME_DELTA = 2;   // кадр дольше 2 тиков (лаг сервера/фризы) - проверку пропускаем
const LAG_REAL_MS = 150;     // запас сверх нормального интервала между проверками (CHECK_TICKS тиков = 200 мс при 60 fps): дольше - лаг

// Первые RETURN_FIRST нарушений игрока просто возвращают его в последнюю безопасную точку
// без наказания. Начиная со следующего - обычное наказание (заморозка/derelict, в PvP - предупреждения и бан).
// 0 - сразу наказывать, как раньше.
const RETURN_FIRST = 2;

// После возврата клиент ещё какое-то время может слать старую (читерскую) позицию.
// Пока игрок не "встал" на место (в пределах RETURN_TOLERANCE), проверки не идут и нарушением это не считается.
const RETURN_TOLERANCE = 24;      // допуск от точки возврата (в юнитах мира, 8 = 1 тайл)
const RETURN_SETTLE_CHECKS = 20;  // сколько проверок ждать, пока клиент примет позицию

const LOG_ONLY = false; // true: только писать в лог и чат, без наказаний
let enabled = true;     // античит включён (переключается командой /anticheat)

// Всё работает ТОЛЬКО пока запущен сервер (хост или выделенный сервер).
// В одиночной игре, в меню и на клиенте мод ничего не делает.
function serverActive() {
    try { return !!Vars.net.server(); } catch (e) { return false; }
}
// включён и сервер запущен
function active() {
    return enabled && serverActive();
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

// Пауза. У хоста с подключёнными игроками state.isPaused() возвращает false даже при State.paused,
// поэтому проверяем само состояние игры.
function gamePaused() {
    return Vars.state.is(Packages.mindustry.core.GameState.State.paused) || Vars.state.isPaused();
}

// Тот же вывод, что и у таймера новичка (setHudText): надпись по центру экрана сверху, обновляется на месте
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

// Заморозка: игрок остаётся в своей команде, но не двигается и не стреляет
function freezeJail(p) {
    const uuid = p.uuid();

    // если режим сменили с derelict, возвращаем игрока в его команду
    if (p.team() == Team.derelict) {
        let home = homeTeam[uuid];
        if (home == null || home == Team.derelict) home = Vars.state.rules.defaultTeam;
        p.team(home);
    }

    if (p.dead()) return;
    const u = p.unit();
    if (u == null) return;

    // эффекты действуют ровно столько, сколько осталось наказания (jail хранится в мс),
    // и обновляются при каждой проверке, поэтому не слетают
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

function pvpViolation(p, moved, allowed) {
    const uuid = p.uuid();
    const n = (pvpStrikes[uuid] || 0) + 1;
    pvpStrikes[uuid] = n;

    delete last[p.id];

    if (n >= PVP_BAN_AT) {
        Call.sendMessage("[scarlet][anticheat][white] " + p.name + "[white] рывок на " + Math.round(moved) + " (допустимо " + Math.round(allowed) + "). Нарушение №" + n + ", бан");
        Log.info("[anticheat] " + p.name + " (" + uuid + ") нарушение " + n + ", бан");
        Vars.netServer.admins.banPlayerID(uuid);
        p.kick("Бан за читы (телепорт/ускорение)");
    } else {
        p.sendMessage("[scarlet][anticheat][white] рывок на " + Math.round(moved) + " (допустимо " + Math.round(allowed) + "). Предупреждение " + n + "/" + PVP_BAN_AT);
    }
}

// Ставит игрока в последнюю безопасную точку. true - вернули, false - точки нет
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
    pending[p.id] = { unit: u, x: s.x, y: s.y, left: RETURN_SETTLE_CHECKS };
    return true;
}

// Игрока только что вернули: ждём, пока клиент примет позицию. true - ещё ждём (проверки пропускаем)
function holdPending(p, u) {
    const pend = pending[p.id];
    if (pend == null) return false;

    if (u == null || pend.unit != u) {
        delete pending[p.id];
        return false;
    }

    pend.left--;
    const off = Mathf.dst(u.x, u.y, pend.x, pend.y);
    if (off > RETURN_TOLERANCE && pend.left > 0) {
        // клиент ещё шлёт старую позицию: ставим на место ещё раз, без нарушения
        try {
            u.set(pend.x, pend.y);
            u.vel.setZero();
            Call.setPosition(p.con, pend.x, pend.y);
        } catch (err) {}
    } else {
        // встал на место (или время вышло): заново начинаем слежение отсюда
        delete pending[p.id];
        delete last[p.id];
    }
    return true;
}

// Возврат в последнюю безопасную точку вместо наказания. true - вернули, false - нужно наказывать
function tryReturn(p, u, desc) {
    if (RETURN_FIRST <= 0) return false;

    const s = safe[p.id];
    if (s == null || s.unit != u) return false;

    const uuid = p.uuid();
    const n = (returns[uuid] || 0) + 1;
    if (n > RETURN_FIRST) return false;
    returns[uuid] = n;

    moveBack(p, u);

    p.sendMessage("[scarlet][anticheat][white] " + desc + ". Возврат в исходную точку " + n + "/" + RETURN_FIRST);
    return true;
}

function punish(p, moved, allowed) {
    // после каждого наказания возвраты (предупреждения) начинаются заново
    delete returns[p.uuid()];

    if (Vars.state.rules.pvp) {
        pvpViolation(p, moved, allowed);
        return;
    }

    const uuid = p.uuid();
    const n = (strikes[uuid] || 0) + 1;
    strikes[uuid] = n;

    const what = punishMode() == "freeze" ? "заморозка" : "derelict";
    const secs = n * BASE_SECONDS;
    jail[uuid] = secs * 1000;
    homeTeam[uuid] = p.team();

    Call.sendMessage("[scarlet][anticheat][white] " + p.name + "[white] рывок на " + Math.round(moved) + " (допустимо " + Math.round(allowed) + "). Нарушение №" + n + ", " + what + " на " + fmt(secs));

    delete last[p.id];
    applyJail(p);
}

// ========== НОМЕРА ИГРОКОВ ==========
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

// Список игроков очищается при запуске и закрытии сервера
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

// Все игроки онлайн (кроме хоста) по порядку номеров, со страйками и наказанием
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

// По номеру находит игрока, даже если он уже вышел: { id, uuid, name, player (или null) }
function findByNumber(arg) {
    const id = parseInt(arg);
    const uuid = uuidById[id];
    if (uuid == null) return null;

    const online = findOnline(uuid);
    return { id: id, uuid: uuid, name: online != null ? online.plainName() : nameById[id], player: online };
}

// Игрок онлайн по номеру или по части ника
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

function setEnabled(v) {
    enabled = v;
    if (!v) {
        // античит выключен: возвращаем всех из derelict и забываем слежение
        Groups.player.each(p => {
            if (jail[p.uuid()] != null) release(p);
        });
        for (let key in last) delete last[key];
    } else {
        lastCheck = Time.millis();
    }
}

// ========== ОСНОВНОЙ ЦИКЛ ==========
Events.run(Trigger.update, () => {
    tick++;

    // пауза: ничего не проверяем и не считаем время наказания
    if (gamePaused()) {
        wasPaused = true;
        lastCheck = Time.millis();
        accDelta = 0;
        maxFrameDelta = 0;
        return;
    }

    accDelta += Time.delta;
    if (Time.delta > maxFrameDelta) maxFrameDelta = Time.delta;

    if (tick % CHECK_TICKS != 0) return;

    const now = Time.millis();
    const dt = Math.min(now - lastCheck, 2000);
    lastCheck = now;

    // сколько тиков реально прошло: берём большее из игрового и реального времени
    const elapsed = Math.max(accDelta, dt / 1000 * 60, CHECK_TICKS);
    const lagged = wasPaused || maxFrameDelta > LAG_FRAME_DELTA || dt > CHECK_TICKS / 60 * 1000 + LAG_REAL_MS;
    accDelta = 0;
    maxFrameDelta = 0;

    if (!active()) return;

    // после паузы или лага заново запоминаем позиции, этот круг пропускаем
    if (lagged) {
        wasPaused = false;
        for (let key in last) delete last[key];
    }

    Groups.player.each(p => {
        if (p.isLocal()) return;

        const uuid = p.uuid();

        // Наказание
        if (jail[uuid] != null) {
            jail[uuid] -= dt;

            if (jail[uuid] <= 0) {
                release(p);
                delete pending[p.id];
            } else {
                showJailTime(p, jail[uuid]);
                applyJail(p);
                // наказанного тоже удерживаем на точке возврата, пока клиент не примет позицию
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

        // ===== Игрока только что вернули: ждём, пока клиент примет позицию =====
        if (holdPending(p, u)) return;

        // ===== Корабль на суше =====
        if (u.type.naval && !u.type.flying) {
            const tile = u.tileOn();
            if (tile != null) {
                const floor = tile.floor();
                if (!floor.isLiquid) {
                    if (LOG_ONLY) {
                        Log.info("[anticheat] " + p.name + " корабль на суше (" + floor.name + ")");
                        Call.sendMessage("[scarlet][anticheat][white] " + p.name + "[white] корабль на суше");
                    } else {
                        if (!tryReturn(p, u, "корабль на суше")) {
                            moveBack(p, u);
                            punish(p, 999, 0);
                        }
                    }
                    delete last[p.id];
                    return;
                }
            }
        }

        // ===== Проверка скорости / телепорта =====
        if (r == null || r.unit != u || r.type != u.type) {
            last[p.id] = { unit: u, type: u.type, x: u.x, y: u.y, grace: GRACE_CHECKS };
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
        const allowed = Math.max(u.speed() * elapsed * LAG_MULT, MIN_ALLOWED);
        const maxVel = u.speed() * VEL_MULT;
        const curVel = u.vel.len();

        if (moved > allowed || curVel > maxVel) {
            if (LOG_ONLY) {
                Log.info("[anticheat] " + p.name + " рывок на " + Math.round(moved) + " / vel " + Math.round(curVel));
                Call.sendMessage("[scarlet][anticheat][white] " + p.name + "[white] рывок на " + Math.round(moved));
                r.x = u.x;
                r.y = u.y;
                return;
            }
            const jump = Math.max(moved, curVel);
            if (!tryReturn(p, u, "рывок на " + Math.round(jump) + " (допустимо " + Math.round(allowed) + ")")) {
                moveBack(p, u);
                punish(p, jump, allowed);
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

// ========== СБРОС ДАННЫХ ТОЛЬКО ПРИ ПЕРЕЗАПУСКЕ ХОСТА ==========
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

    enabled = true;
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

// ========== ЗАПРЕТ ДЕЙСТВИЙ ДЛЯ НАКАЗАННЫХ ==========
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

// Новый юнит у наказанного (респавн, смена юнита): сразу заново накладываем заморозку
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

// ========== ЭКСПОРТ ДЛЯ commands.js ==========
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
    isEnabled: active,          // включён И сервер запущен
    isServer: serverActive,     // сервер запущен
    isSwitchOn: function() { return enabled; }, // сам переключатель /anticheat
    setEnabled: setEnabled,
    getPunishMode: punishMode,
    setPunishMode: setPunishMode
};
