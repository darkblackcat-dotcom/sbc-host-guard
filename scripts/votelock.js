const S = require("hgsettings"); // числовые настройки берутся из меню: Настройки -> HostGuard

const ac = require("anticheat");


const AT = Packages.mindustry.net.Administration$ActionType;
let enabled = true;   // блокировка включена (переключается командой /votelock)
let lastMsg = 0;
let warned = false;

function voteTarget() {
    try {
        const R = Packages.arc.util.Reflect;
        const arr = R.get(Vars.netServer, "currentlyKicking");
        if (arr == null || arr[0] == null) return null;
        return R.get(arr[0], "target");
    } catch (e) {
        if (!warned) {
            warned = true;
            Log.err("[votelock] не удалось прочитать данные голосования: " + e);
        }
        return null;
    }
}

Vars.netServer.admins.addActionFilter(action => {
    if (!enabled || !ac.isServer()) return true;
    if (action.type != AT.placeBlock && action.type != AT.breakBlock) return true;

    const p = action.player;
    if (p == null) return true;

    const target = voteTarget();
    if (target == null || target.uuid() != p.uuid()) return true;

    const now = Time.millis();
    if (now - lastMsg > S.get("msg_cooldown")) {
        lastMsg = now;
        p.sendMessage("[scarlet]Пока идёт голосование против тебя, строить нельзя.");
    }
    return false;
});

function registerCommand() {
    if (!Vars.netServer) return;
    const h = Vars.netServer.clientCommands;

    try { h.removeCommand("votelock"); } catch (e) {}

    h.register("votelock", "", "Включить/выключить запрет строить цели /votekick", new Packages.arc.util.CommandHandler.CommandRunner({
        accept: function(args, player) {
            try {
                if (!ac.isServer()) return;
                if (!ac.isAdmin(player)) {
                    player.sendMessage("[scarlet]Только для админов/хоста.");
                    return;
                }
                enabled = !enabled;
                Call.sendMessage("[scarlet][votelock][white] " + player.name + "[white]: votelock " + (enabled ? "включён" : "выключен"));
            } catch (e) {
                Log.err("[votelock] " + e);
                player.sendMessage("[scarlet]Ошибка: " + e);
            }
        }
    }));
}

registerCommand();
Events.on(ServerLoadEvent, registerCommand);
