// antivirus.js — удаляет процессоры-вирусы. Включается и выключается своей командой /antivirus (не зависит от /anticheat).
//
// Вирус - процессор с командой ucontrol build x y <блок> <поворот> <конфиг>, где <конфиг> - @this
// или переменная, в которую @this попал через set, select, op или sensor (в том числе по цепочке).
// Проверка идёт сразу после изменения настройки процессора и раз в SCAN_TICKS тиков по всем процессорам.
// Если известен автор кода, на него запускается голосование на бан (grief.js).

const ac = require("anticheat");
const grief = require("grief");

// ===== Настройки =====
const SCAN_TICKS = 120;         // как часто проверять все процессоры (60 тиков = 1 секунда)
const START_BAN_VOTE = true;    // запускать голосование на бан автора вируса
const DEBUG = false;           // true - писать в лог, что проверяется (для поиска причины, если не срабатывает)

let enabled = true;     // антивирус включён (переключается командой /antivirus)
let tick = 0;
let warned = false;

function isProcessor(b) {
    const bl = b.block;
    return bl == Blocks.microProcessor || bl == Blocks.logicProcessor || bl == Blocks.hyperProcessor;
}

// Разбивает код на строки, а строки на слова.
// Внутри циклов только var: в Rhino const/let в теле цикла застревают на первом значении.
// b.code может прийти как Java-строка, поэтому всё приводится к JS-строке через "" + x.
function parseRows(code) {
    code = "" + code;
    var rows = [];
    var lines = code.split("\n");
    for (var i = 0; i < lines.length; i++) {
        var line = ("" + lines[i]).trim();
        if (line == "") continue;
        var parts = line.split(" ");
        var row = [];
        for (var j = 0; j < parts.length; j++) {
            var w = "" + parts[j];
            if (w.length > 0) row.push(w);
        }
        if (row.length > 0) rows.push(row);
    }
    return rows;
}

// Есть ли в коде build, у которого конфиг - @this или переменная с @this
function isVirus(code) {
    code = "" + code;
    if (code.indexOf("@this") < 0 || code.indexOf("build") < 0) return false;

    var rows = parseRows(code);

    // переменные, в которые попадает @this (в том числе по цепочке set a @this; set b a)
    var holders = {};
    holders["@this"] = true;
    var changed = true;
    for (var pass = 0; changed && pass < 20; pass++) {
        changed = false;
        for (var r = 0; r < rows.length; r++) {
            var t = rows[r];
            var dest = null;
            var src = null;

            if (t[0] == "set" && t.length >= 3) {
                dest = t[1];
                src = [t[2]];
            } else if (t[0] == "select" && t.length >= 7) {
                dest = t[1];
                src = [t[5], t[6]];
            } else if (t[0] == "op" && t.length >= 5) {
                dest = t[2];
                src = [t[3], t[4]];
            } else if (t[0] == "sensor" && t.length >= 4) {
                dest = t[1];
                src = [t[3]];
            }

            if (dest == null || holders[dest] === true) continue;
            for (var k = 0; k < src.length; k++) {
                if (holders[src[k]] === true) {
                    holders[dest] = true;
                    changed = true;
                    break;
                }
            }
        }
    }

    // ucontrol build x y блок поворот конфиг
    for (var r = 0; r < rows.length; r++) {
        var t = rows[r];
        if (t[0] == "ucontrol" && t[1] == "build" && t.length >= 7 && holders[t[6]] === true) return true;
    }
    return false;
}

function report(count, player) {
    const who = player != null ? " Автор: " + player.name + "[white]." : "";
    Call.sendMessage("[scarlet][antivirus][white] Удалено процессоров-вирусов: " + count + "." + who);
    Log.info("[antivirus] удалено вирусов: " + count + (player != null ? ", автор " + player.plainName() + " (" + player.uuid() + ")" : ""));

    if (START_BAN_VOTE && player != null && !ac.isAdmin(player)) {
        grief.startBanVote(player, "вирусный процессор");
    }
}

// Проверка после изменения настройки процессора
if (typeof ConfigEvent !== "undefined") {
    Events.on(ConfigEvent, e => {
        if (!enabled || !ac.isServer()) return;
        const b = e.tile;
        if (b == null || !isProcessor(b)) return;

        const player = e.player;
        Time.run(1, () => {
            try {
                if (!b.isValid()) return;
                const code = "" + b.code;
                const virus = isVirus(code);
                if (DEBUG) Log.info("[antivirus] ConfigEvent: процессор, длина кода " + code.length + ", вирус: " + virus);
                if (!virus) return;
                b.tile.setNet(Blocks.air);
                report(1, player);
            } catch (err) {
                if (!warned) {
                    warned = true;
                    Log.err("[antivirus] ошибка проверки: " + err);
                }
            }
        });
    });
}

// Периодическая проверка всех процессоров
Events.run(Trigger.update, () => {
    tick++;
    if (tick % SCAN_TICKS != 0 || !enabled) return;
    if (!ac.isServer()) return; // сервер не запущен - антивирус не работает
    if (Vars.net.client()) {
        if (DEBUG && tick % (SCAN_TICKS * 5) == 0) Log.info("[antivirus] скан пропущен: игра работает как клиент");
        return;
    }

    try {
        const found = [];
        let n = 0, withBuild = 0;
        Groups.build.each(b => {
            if (!isProcessor(b)) return;
            n++;
            const code = "" + b.code;
            if (code.indexOf("build") >= 0) withBuild++;
            if (isVirus(code)) found.push(b);
        });
        if (DEBUG && tick % (SCAN_TICKS * 5) == 0) {
            Log.info("[antivirus] скан: процессоров " + n + ", с build " + withBuild + ", вирусов " + found.length);
        }
        if (found.length == 0) return;

        found.forEach(b => { b.tile.setNet(Blocks.air); });
        report(found.length, null);
    } catch (err) {
        Log.err("[antivirus] ошибка скана: " + err);
    }
});

// ========== КОМАНДА /antivirus ==========
function parseBool(arg, current) {
    if (arg == null) return !current;
    const s = String(arg).toLowerCase();
    if (["true", "on", "1", "yes", "да", "вкл"].indexOf(s) >= 0) return true;
    if (["false", "off", "0", "no", "нет", "выкл"].indexOf(s) >= 0) return false;
    return null;
}

function registerCommand() {
    if (!Vars.netServer) return;
    const h = Vars.netServer.clientCommands;

    try { h.removeCommand("antivirus"); } catch (e) {}

    h.register("antivirus", "[on/off]", "Включить/выключить антивирус (без аргумента - переключить)", new Packages.arc.util.CommandHandler.CommandRunner({
        accept: function(args, player) {
            try {
                if (!ac.isServer()) return;
                if (!ac.isAdmin(player)) {
                    player.sendMessage("[scarlet]Только для админов/хоста.");
                    return;
                }
                const v = parseBool(args[0], enabled);
                if (v === null) {
                    player.sendMessage("[scarlet]Укажи on или off.");
                    return;
                }
                enabled = v;
                Call.sendMessage("[scarlet][antivirus][white] " + player.name + "[white]: антивирус " + (v ? "включён" : "выключен"));
            } catch (e) {
                Log.err("[antivirus] " + e);
                player.sendMessage("[scarlet]Ошибка: " + e);
            }
        }
    }));
}

registerCommand();
Events.on(ServerLoadEvent, registerCommand);

if (DEBUG) Log.info("[antivirus] ConfigEvent доступен: " + (typeof ConfigEvent !== "undefined"));
