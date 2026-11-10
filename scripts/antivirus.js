const S = require("hgsettings"); // числовые настройки берутся из меню: Настройки -> HostGuard

const ac = require("anticheat");


let tick = 0;
let warned = false;

function isProcessor(b) {
    const bl = b.block;
    return bl == Blocks.microProcessor || bl == Blocks.logicProcessor || bl == Blocks.hyperProcessor;
}

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

function isVirus(code) {
    code = "" + code;
    if (code.indexOf("@this") < 0 || code.indexOf("build") < 0) return false;

    var rows = parseRows(code);

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
}

if (typeof ConfigEvent !== "undefined") {
    Events.on(ConfigEvent, e => {
        if (!S.get("antivirus_on") || !ac.isServer()) return;
        const b = e.tile;
        if (b == null || !isProcessor(b)) return;

        const player = e.player;
        Time.run(1, () => {
            try {
                if (!b.isValid()) return;
                const code = "" + b.code;
                const virus = isVirus(code);
                if (S.get("debug")) Log.info("[antivirus] ConfigEvent: процессор, длина кода " + code.length + ", вирус: " + virus);
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

Events.run(Trigger.update, () => {
    tick++;
    if (tick % S.get("scan_ticks") != 0 || !S.get("antivirus_on")) return;
    if (!ac.isServer()) return;
    if (Vars.net.client()) {
        if (S.get("debug") && tick % (S.get("scan_ticks") * 5) == 0) Log.info("[antivirus] скан пропущен: игра работает как клиент");
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
        if (S.get("debug") && tick % (S.get("scan_ticks") * 5) == 0) {
            Log.info("[antivirus] скан: процессоров " + n + ", с build " + withBuild + ", вирусов " + found.length);
        }
        if (found.length == 0) return;

        found.forEach(b => { b.tile.setNet(Blocks.air); });
        report(found.length, null);
    } catch (err) {
        Log.err("[antivirus] ошибка скана: " + err);
    }
});



if (S.get("debug")) Log.info("[antivirus] ConfigEvent доступен: " + (typeof ConfigEvent !== "undefined"));
