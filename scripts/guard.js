const S = require("hgsettings"); // числовые настройки берутся из меню: Настройки -> HostGuard

const ac = require("anticheat");

let enabled = true;   // защита включена (переключается командой /guard)

function active() {
    return enabled && ac.isServer();
}

const LOG_PER_PAGE = 16;     // строк на странице /log
const DANGEROUS_BLOCKS = ["thorium-reactor"]; // внутренние имена блоков, добавляйте свои
// Опасные блоки возле ядра (DANGER_RADIUS_TILES) могут ставить ТОЛЬКО хост и админы.
const OWN_ONLY = ["breakBlock", "configure", "rotate"]; // новичок может это делать только со своими блоками

const actionLog = [];        // записи: { t, u, n, a: "p"|"b", blk, x, y, rot, team, cfg }
const owner = {};      // "x,y" -> { u: uuid, b: имя блока }
const joined = {};     // uuid -> время входа
const lastMsg = {};    // uuid -> когда последний раз писали о запрете
const lastDangerMsg = {}; // uuid -> когда последний раз писали о запрете опасного блока
let trusted = {};      // uuid -> true
let warned = false;

function isRestricted(p) {
    if (!active() || ac.isAdmin(p)) return false;

    const uuid = p.uuid();
    if (trusted[uuid]) return false;

    const now = Time.millis();
    if (joined[uuid] == null) joined[uuid] = now;

    if (S.get("auto_trust") && now - joined[uuid] >= S.get("newbie_minutes") * 60000) {
        trusted[uuid] = true;
        return false;
    }
    return true;
}

const CONSTRUCT = /^build\d+$/;

function keyOf(t) {
    return t.x + "," + t.y;
}

function originOf(tile) {
    return tile.build != null ? tile.build.tile : tile;
}

function blockNameAt(tile) {
    let name = String(tile.block().name);
    if (CONSTRUCT.test(name) && tile.build != null) {
        try { name = String(tile.build.current.name); } catch (e) {}
    }
    return name;
}

function isOwn(uuid, tile) {
    if (tile == null) return false;
    const o = owner[keyOf(originOf(tile))];
    return o != null && o.u == uuid && o.b == blockNameAt(tile);
}

function pushLog(e) {
    const last = actionLog.length > 0 ? actionLog[actionLog.length - 1] : null;
    if (last != null && last.u == e.u && last.a == e.a && last.x == e.x && last.y == e.y && last.blk == e.blk) return;

    actionLog.push(e);
    if (actionLog.length > S.get("log_max")) actionLog.splice(0, 500);
}

function revert(e) {
    const tile = Vars.world.tile(e.x, e.y);
    if (tile == null) return 0;

    const block = Vars.content.block(e.blk);
    if (block == null) return 0;

    const team = Team.get(e.team);

    if (e.a == "p") {
        if (tile.build != null && tile.team() == team && blockNameAt(tile) == e.blk) {
            tile.setNet(Blocks.air);
            delete owner[e.x + "," + e.y];
            return 2;
        }
        return 0;
    }

    if (tile.block() == Blocks.air && Packages.mindustry.world.Build.validPlace(block, team, e.x, e.y, e.rot)) {
        tile.setNet(block, team, e.rot);
        if (e.cfg != null && tile.build != null) {
            try { tile.build.configureAny(e.cfg); } catch (err) {}
        }
        return 1;
    }
    return 0;
}

function rollback(uuid, minutes, done) {
    const since = minutes > 0 ? Time.millis() - minutes * 60000 : 0;
    const list = [];
    for (let i = actionLog.length - 1; i >= 0; i--) {
        var e = actionLog[i];
        if (e.u == uuid && e.t >= since) list.push(e);
    }
    if (list.length == 0) return 0;

    let idx = 0;
    let restored = 0;
    let removed = 0;
    let skipped = 0;

    function step() {
        try {
            const end = Math.min(idx + 100, list.length);
            for (; idx < end; idx++) {
                try {
                    const r = revert(list[idx]);
                    if (r == 1) { restored++; list[idx].done = true; }
                    else if (r == 2) { removed++; list[idx].done = true; }
                    else skipped++;
                } catch (err) {
                    skipped++;
                    Log.err("[guard] ошибка отката: " + err);
                }
            }
        } catch (err) {
            Log.err("[guard] сбой пакета отката: " + err);
            idx = list.length;
        }
        if (idx < list.length) {
            Core.app.post(() => Time.run(1, step));
        } else {
            let w = 0;
            for (let i = 0; i < actionLog.length; i++) {
                if (!actionLog[i].done) actionLog[w++] = actionLog[i];
            }
            actionLog.length = w;
            if (done != null) done(restored, removed);
        }
    }
    step();

    return list.length;
}

function isPrivileged(p) {
    if (Vars.player != null && p == Vars.player) return true;
    if (p.admin) return true;
    return ac.isAdmin(p);
}

function dangerNearCore(p, action) {
    const block = action.block;
    const tile = action.tile;
    if (block == null || tile == null) return false;
    if (DANGEROUS_BLOCKS.indexOf(String(block.name)) < 0) return false;

    const wx = tile.worldx();
    const wy = tile.worldy();
    const r = S.get("danger_radius") * Vars.tilesize;

    let near = false;
    p.team().data().cores.each(core => {
        if (core.dst(wx, wy) <= r) near = true;
    });
    return near;
}

function deny(p, text) {
    const uuid = p.uuid();
    const now = Time.millis();
    if (lastMsg[uuid] == null || now - lastMsg[uuid] > 2000) {
        lastMsg[uuid] = now;
        p.sendMessage("[scarlet]" + text);
    }
    return false;
}

let filterInstalled = false;

function installActionFilter() {
    if (filterInstalled || !Vars.netServer) return;
    filterInstalled = true;

    Vars.netServer.admins.addActionFilter(action => {
        try {
            const p = action.player;
            if (p == null || !active()) return true;

            const type = String(action.type);
            const uuid = p.uuid();
            const tile = action.tile;

            if (type == "placeBlock" && !isPrivileged(p) && dangerNearCore(p, action)) {
                const nowD = Time.millis();
                if (lastDangerMsg[uuid] == null || nowD - lastDangerMsg[uuid] > 2000) {
                    lastDangerMsg[uuid] = nowD;
                    p.sendMessage("[scarlet]Этот блок могут ставить только хост и админы.");
                }
                return false;
            }

            if (isRestricted(p)) {
                if (OWN_ONLY.indexOf(type) >= 0 && !isOwn(uuid, tile)) {
                    return deny(p, "Новичкам пока можно трогать только свои блоки.");
                }
                if (type == "placeBlock" && tile != null) {
                    const bn = String(tile.block().name);
                    if (bn != "air" && !CONSTRUCT.test(bn) && !isOwn(uuid, tile)) {
                        return deny(p, "Новичкам пока нельзя заменять чужие блоки.");
                    }
                }
            }

            if (type == "placeBlock" && tile != null && action.block != null) {
                const name = String(action.block.name);
                const k = keyOf(tile);
                const nowP = Time.millis();
                const prev = owner[k];
                const dup = prev != null && prev.u == uuid && prev.b == name && nowP - prev.t < 60000;
                if (!dup) {
                    owner[k] = { u: uuid, b: name, t: nowP };
                    pushLog({
                        t: nowP, u: uuid, n: p.plainName(), a: "p", blk: name,
                        x: tile.x, y: tile.y, rot: action.rotation, team: p.team().id, cfg: action.config
                    });
                }
            } else if (type == "breakBlock" && tile != null && tile.build != null) {
                const bn = String(tile.block().name);
                if (!CONSTRUCT.test(bn)) {
                    const o = tile.build.tile;
                    pushLog({
                        t: Time.millis(), u: uuid, n: p.plainName(), a: "b", blk: bn,
                        x: o.x, y: o.y, rot: tile.build.rotation, team: tile.build.team.id, cfg: tile.build.config()
                    });
                }
            }

            return true;
        } catch (err) {
            if (!warned) {
                warned = true;
                Log.err("[guard] ошибка в фильтре действий: " + err);
            }
            return true;
        }
    });
}

installActionFilter();
Events.on(ServerLoadEvent, installActionFilter);
Events.on(ClientLoadEvent, installActionFilter);

Events.on(PlayerJoin, e => {
    if (!ac.isServer()) return;
    const p = e.player;
    joined[p.uuid()] = Time.millis();
    if (active() && !ac.isAdmin(p) && !trusted[p.uuid()]) {
        p.sendMessage("[accent]Первые " + S.get("newbie_minutes") + " мин нельзя ломать и заменять чужие блоки.");
    }
});

Events.on(PlayerLeave, e => {
    const uuid = e.player.uuid();
    delete joined[uuid];
    delete lastMsg[uuid];
    delete lastDangerMsg[uuid];
    delete hudShown[uuid];
});

const hudShown = {}; // uuid -> true, если игроку сейчас показан таймер

function fmtTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const r = s % 60;
    return Math.floor(s / 60) + ":" + (r < 10 ? "0" : "") + r;
}

let lastHudTick = Time.millis();

function updateHud() {
    try {
        const now = Time.millis();
        const passed = now - lastHudTick;
        lastHudTick = now;
        if (!ac.isServer()) return;

        if (ac.isPaused()) {
            for (let key in joined) joined[key] += passed;
        }

        Groups.player.each(p => {
            if (p.con == null) return;
            const uuid = p.uuid();
            if (ac.jail[uuid] != null) return;
            if (isRestricted(p)) {
                if (S.get("auto_trust") && joined[uuid] != null) {
                    const left = S.get("newbie_minutes") * 60000 - (Time.millis() - joined[uuid]);
                    Call.setHudText(p.con, "[accent]До конца статуса новичка: [white]" + fmtTime(left));
                    hudShown[uuid] = true;
                }
            } else if (hudShown[uuid]) {
                Call.hideHudText(p.con);
                delete hudShown[uuid];
            }
        });
    } catch (e) {}
}

Timer.schedule(updateHud, 1, 1);

function runner(fn) {
    return new Packages.arc.util.CommandHandler.CommandRunner({
        accept: function(args, player) {
            try {
                if (!ac.isServer()) return;
                if (!ac.isAdmin(player)) {
                    player.sendMessage("[scarlet]Только для админов/хоста.");
                    return;
                }
                if (!enabled) {
                    player.sendMessage("[scarlet]Guard выключен (включить: /guard).");
                    return;
                }
                fn(args, player);
            } catch (e) {
                Log.err("[guard] " + e);
                player.sendMessage("[scarlet]Ошибка: " + e);
            }
        }
    });
}

function resolveTarget(arg) {
    if (/^\d+$/.test(String(arg))) {
        const n = ac.findByNumber(arg);
        return n != null ? { uuid: n.uuid, name: n.name } : null;
    }

    const online = ac.findPlayerByNameOrNumber(arg);
    if (online != null) return { uuid: online.uuid(), name: online.plainName() };

    const q = String(arg).toLowerCase();
    for (let i = actionLog.length - 1; i >= 0; i--) {
        if (actionLog[i].n.toLowerCase().indexOf(q) >= 0) return { uuid: actionLog[i].u, name: actionLog[i].n };
    }
    return null;
}

function ago(ms) {
    const s = Math.floor((Time.millis() - ms) / 1000);
    if (s < 60) return s + " с";
    if (s < 3600) return Math.floor(s / 60) + " мин";
    return Math.floor(s / 3600) + " ч";
}

function cmdLog(args, player) {
    let q = null;
    let uid = null;
    let page = 1;

    if (args.length == 1 && /^\d+$/.test(String(args[0]))) {
        page = parseInt(args[0]);
    } else if (args.length > 0) {
        if (/^\d+$/.test(String(args[0]))) {
            const t = ac.findByNumber(args[0]);
            if (t == null) {
                player.sendMessage("[scarlet]Игрока с таким номером не было.");
                return;
            }
            uid = t.uuid;
        } else {
            q = String(args[0]).toLowerCase();
        }
        if (args.length > 1) page = parseInt(args[1]);
    }

    const groups = [];
    for (let i = actionLog.length - 1; i >= 0; i--) {
        var e = actionLog[i];
        if (uid != null && e.u != uid) continue;
        if (q != null && e.n.toLowerCase().indexOf(q) < 0) continue;

        var g = groups.length > 0 ? groups[groups.length - 1] : null;
        if (g != null && g.u == e.u && g.a == e.a && g.blk == e.blk) g.count++;
        else groups.push({ u: e.u, n: e.n, a: e.a, blk: e.blk, x: e.x, y: e.y, t: e.t, count: 1 });
    }

    if (groups.length == 0) {
        player.sendMessage("[yellow]Журнал пуст.");
        return;
    }

    const pages = Math.max(1, Math.ceil(groups.length / LOG_PER_PAGE));
    if (isNaN(page) || page < 1 || page > pages) {
        player.sendMessage("[scarlet]Страница должна быть числом от[orange] 1[] до[orange] " + pages + "[scarlet].");
        return;
    }

    let text = "[orange]-- Журнал, страница[lightgray] " + page + "[gray]/[lightgray]" + pages + "[orange] --\n";
    const from = (page - 1) * LOG_PER_PAGE;
    for (let k = from; k < Math.min(from + LOG_PER_PAGE, groups.length); k++) {
        var g = groups[k];
        text += "[gray]" + ago(g.t) + " [white]" + g.n + " [orange]" + (g.a == "p" ? "поставил" : "сломал")
            + "[white] " + g.blk + (g.count > 1 ? "[gray] ×" + g.count : "") + " [gray](" + g.x + "," + g.y + ")\n";
    }
    player.sendMessage(text);
}

function cmdRollback(args, player) {
    if (args.length == 0) {
        player.sendMessage("[scarlet]Использование: /rollback <игрок> [минуты]");
        return;
    }
    const t = resolveTarget(args[0]);
    if (t == null) {
        player.sendMessage("[scarlet]Игрок не найден (ни онлайн, ни в журнале).");
        return;
    }
    const minutes = args.length > 1 ? parseInt(args[1]) : 0;
    if (isNaN(minutes) || minutes < 0) {
        player.sendMessage("[scarlet]Минуты должны быть числом.");
        return;
    }

    const total = rollback(t.uuid, minutes, (restored, removed) => {
        Call.sendMessage("[accent][rollback][white] Откат действий " + t.name + "[white]: восстановлено " + restored + ", убрано " + removed);
    });
    player.sendMessage(total == 0 ? "[yellow]В журнале нет действий этого игрока." : "[accent]Откат запущен, действий: " + total);
}

function cmdTrust(args, player, on) {
    if (args.length == 0) {
        player.sendMessage("[scarlet]Укажи игрока.");
        return;
    }
    const t = resolveTarget(args[0]);
    if (t == null) {
        player.sendMessage("[scarlet]Игрок не найден.");
        return;
    }
    if (on) trusted[t.uuid] = true;
    else delete trusted[t.uuid];
    player.sendMessage("[green]" + t.name + (on ? " теперь доверенный." : " больше не доверенный (снова новичок на " + S.get("newbie_minutes") + " мин)."));
    if (!on) joined[t.uuid] = Time.millis();
}

function registerCommands() {
    if (!Vars.netServer) return;
    const h = Vars.netServer.clientCommands;

    ["guard", "log", "rollback", "trust", "untrust"].forEach(n => { try { h.removeCommand(n); } catch (e) {} });

    h.register("guard", "", "Включить/выключить guard: режим новичка, опасные блоки, журнал", new Packages.arc.util.CommandHandler.CommandRunner({
        accept: function(args, player) {
            try {
                if (!ac.isServer()) return;
                if (!ac.isAdmin(player)) {
                    player.sendMessage("[scarlet]Только для админов/хоста.");
                    return;
                }
                enabled = !enabled;
                Call.sendMessage("[scarlet][guard][white] " + player.name + "[white]: guard " + (enabled ? "включён" : "выключен"));
            } catch (e) {
                Log.err("[guard] " + e);
                player.sendMessage("[scarlet]Ошибка: " + e);
            }
        }
    }));
    h.register("log", "[player] [page]", "Журнал построек и разрушений", runner(cmdLog));
    h.register("rollback", "<player> [minutes]", "Откатить действия игрока", runner(cmdRollback));
    h.register("trust", "<player>", "Сделать игрока доверенным (снять ограничения новичка)", runner((args, player) => cmdTrust(args, player, true)));
    h.register("untrust", "<player>", "Снять доверие (снова новичок)", runner((args, player) => cmdTrust(args, player, false)));
}

registerCommands();
Events.on(ServerLoadEvent, registerCommands);

module.exports = {
    rollback: rollback,
    isTrusted: function(p) { return !!trusted[p.uuid()]; },
    isEnabled: active,
    isNewbie: isRestricted
};

